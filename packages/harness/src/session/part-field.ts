import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { SessionPartFieldCache } from "./part-field-cache"
import { SessionPartFieldSource } from "./part-field-source"
import { StorageConflictError } from "../storage/errors"

export namespace SessionPartField {
  export const Field = z.enum(["text", "raw", "input", "output", "error"])
  export type Field = z.infer<typeof Field>
  export const Conflict = NamedError.create("SessionPartFieldConflict", z.object({ message: z.string() }))
  const Range = z.object({
    version: z.string().optional(),
    field: Field,
    offset: z.number().int().nonnegative().safe().default(0),
    length: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024)
      .default(64 * 1024),
  })
  export type Range = z.input<typeof Range>
  export type Header = SessionPartFieldSource.Header
  export interface Descriptor {
    field: Field
    bytes: number
    sha256: string
    mediaType: string
    original: "complete" | "partial"
  }
  interface Source {
    field: Field
    mediaType: string
    original: Descriptor["original"]
    raw: SessionPartFieldSource.ResolvedSource
    bytes?: number
    sha256?: string
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>
  }
  const jobs = RuntimeContext.state(() => ({
    pending: new Map<string, { key: string[]; version: string }>(),
    failures: new Map<string, unknown>(),
    bytes: 0,
    controller: new AbortController(),
    active: undefined as { id: string; bytes: number } | undefined,
    running: undefined as Promise<void> | undefined,
    closed: false,
  }))
  async function capture(key: string[], signal?: AbortSignal) {
    try {
      const selected = await SessionPartFieldSource.get(key, signal)
      return {
        version: selected.version,
        header: selected.header,
        sources: selected.fields.map((source): Source => ({
          field: source.field,
          raw: source,
          mediaType: source.mediaType,
          original: source.original,
          bytes:
            source.kind === "artifact"
              ? source.reference.bytes
              : source.kind === "checkpoint"
                ? undefined
                : source.bytes,
          sha256:
            source.kind === "artifact"
              ? (source.reference.sha256 ?? undefined)
              : source.kind === "checkpoint"
                ? undefined
                : source.sha256,
          stream: (signal) => SessionPartFieldSource.stream(key, source, signal),
        })),
      }
    } catch (error) {
      if (error instanceof StorageConflictError)
        throw new Conflict({ message: "Part field content changed; refresh its descriptor" })
      throw error
    }
  }
  function direct(source: Source) {
    return (
      (source.raw.kind === "artifact" || source.raw.kind === "chunks") &&
      source.sha256 !== undefined &&
      source.bytes !== undefined
    )
  }

  async function assertCurrent(key: string[], version: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const selected = await capture(key, signal)
    if (selected.version !== version)
      throw new Conflict({ message: "Part field content changed; refresh its descriptor" })
  }

  async function current<T>(key: string[], version: string, signal: AbortSignal | undefined, fn: () => Promise<T>) {
    try {
      const result = await fn()
      await assertCurrent(key, version, signal)
      return result
    } catch (error) {
      await assertCurrent(key, version, signal)
      throw error
    }
  }

  function start() {
    const state = jobs()
    if (state.running || state.closed) return
    const runtime = RuntimeContext.current()
    const running = runtime.run(async () => {
      while (state.pending.size && !state.closed) {
        const [id, item] = state.pending.entries().next().value!
        state.pending.delete(id)
        state.bytes -= Buffer.byteLength(id)
        state.active = { id, bytes: 0 }
        try {
          const selected = await capture(item.key, state.controller.signal)
          if (selected.version !== item.version) continue
          let completed = 0
          for (const source of selected.sources) {
            if (direct(source)) continue
            const result = await SessionPartFieldCache.prepare({
              key: item.key,
              field: source.field,
              nativeVersion: item.version,
              source,
              signal: state.controller.signal,
              validate: () => assertCurrent(item.key, item.version, state.controller.signal),
              progress(bytes) {
                if (state.active?.id === id) state.active.bytes = completed + bytes
              },
            })
            completed += result.bytes
          }
        } catch (error) {
          if (state.closed && error !== state.controller.signal.reason) throw error
          if (!state.closed) {
            state.failures.set(id, error)
            while (
              state.failures.size > 16 ||
              [...state.failures.keys()].reduce((sum, key) => sum + Buffer.byteLength(key), 0) > 64 * 1024
            )
              state.failures.delete(state.failures.keys().next().value!)
          }
        } finally {
          state.active = undefined
        }
      }
    })
    state.running = running
    void running
      .finally(() => {
        if (state.running === running) state.running = undefined
      })
      .catch(() => {})
  }

  export async function prepare(key: string[], signal?: AbortSignal) {
    const state = jobs()
    if (state.closed) throw new Error("Native Part field preparation is closed")
    SessionPartFieldCache.start()
    const selected = await capture(key, signal)
    const fields: Descriptor[] = []
    let ready = true
    for (const source of selected.sources) {
      if (direct(source)) {
        fields.push({
          field: source.field,
          bytes: source.bytes!,
          sha256: source.sha256!,
          mediaType: source.mediaType,
          original: source.original,
        })
        continue
      }
      const cached = await SessionPartFieldCache.inspect(key, source.field, selected.version)
      if (!cached) {
        ready = false
        continue
      }
      fields.push({
        field: source.field,
        bytes: cached.bytes,
        sha256: cached.sha256,
        mediaType: source.mediaType,
        original: source.original,
      })
    }
    await assertCurrent(key, selected.version, signal)
    if (ready) return { state: "ready" as const, version: selected.version, header: selected.header, fields }
    const id = JSON.stringify([key, selected.version])
    if (state.failures.has(id)) {
      const error = state.failures.get(id)
      state.failures.delete(id)
      throw error
    }
    const size = Buffer.byteLength(id)
    if (
      state.active?.id !== id &&
      !state.pending.has(id) &&
      state.pending.size < 16 &&
      state.bytes + size <= 64 * 1024
    ) {
      state.pending.set(id, { key: [...key], version: selected.version })
      state.bytes += size
      start()
    }
    return {
      state: "preparing" as const,
      version: selected.version,
      phase:
        state.active?.id === id
          ? ("materializing" as const)
          : state.pending.has(id)
            ? ("queued" as const)
            : ("busy" as const),
      completedBytes: state.active?.id === id ? state.active.bytes : 0,
    }
  }

  async function wait(promise: Promise<unknown>, signal?: AbortSignal) {
    if (!signal) {
      await promise
      return
    }
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
        }),
      ])
    } finally {
      if (abort) signal.removeEventListener("abort", abort)
    }
  }

  export async function descriptor(key: string[], signal?: AbortSignal) {
    for (;;) {
      const result = await prepare(key, signal)
      if (result.state === "ready") return { version: result.version, header: result.header, fields: result.fields }
      await wait(jobs().running ?? Promise.resolve(), signal)
    }
  }

  export async function stop() {
    const state = jobs()
    state.closed = true
    state.controller.abort(new Error("Runtime is closing native Part field preparation"))
    state.pending.clear()
    state.bytes = 0
    const results = await Promise.allSettled([state.running, SessionPartFieldCache.stop()])
    state.failures.clear()
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Native Part field shutdown failed")
  }

  export async function read(key: string[], value: Range, signal?: AbortSignal) {
    const input = Range.parse(value)
    const selected = await capture(key, signal)
    const version = selected.version
    if (input.version && input.version !== version)
      throw new Conflict({ message: "Part field content changed; refresh its descriptor" })
    return current(key, version, signal, async () => {
      const source = selected.sources.find((source) => source.field === input.field)
      if (!source) throw new Storage.NotFoundError({ message: "The requested native Part field is unavailable" })
      if (direct(source)) {
        const data = await SessionPartFieldSource.range(key, source.raw, input.offset, input.length, signal)
        if (!data) throw new StorageIntegrityError("Native field source cannot serve its declared range")
        return {
          version,
          field: input.field,
          offset: input.offset,
          nextOffset: input.offset + data.byteLength,
          totalBytes: source.bytes!,
          sha256: source.sha256!,
          mediaType: source.mediaType,
          original: source.original,
          data,
          complete: input.offset + data.byteLength === source.bytes,
        }
      }
      await descriptor(key, signal)
      const cached = await SessionPartFieldCache.read({
        key,
        field: input.field,
        nativeVersion: version,
        offset: input.offset,
        length: input.length,
        signal,
      })
      return {
        version,
        field: input.field,
        offset: input.offset,
        nextOffset: input.offset + cached.data.length,
        totalBytes: cached.bytes,
        sha256: cached.sha256,
        mediaType: source.mediaType,
        original: source.original,
        data: cached.data,
        complete: input.offset + cached.data.length === cached.bytes,
      }
    })
  }
}
