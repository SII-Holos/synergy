import { createHash } from "node:crypto"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { PartContent } from "./part-content"
import { MessageV2 } from "./message-v2"
import { RolloutSchema } from "./rollout/schema"
import { RolloutArtifact } from "./rollout/artifact"
import { RolloutLedger } from "./rollout/ledger"
import { StoredToolOutput } from "../tool/stored-output"
import { SessionPartFieldCache } from "./part-field-cache"

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
  type ToolHeaderState<T> = T extends unknown ? Omit<T, "input" | "raw" | "output" | "error"> : never
  export type Header =
    | PartContent.Header
    | (Omit<MessageV2.ToolPart, "state"> & { state: ToolHeaderState<MessageV2.ToolPart["state"]> })
    | Omit<MessageV2.CompactionRecoveryPart, "summary">
    | (Omit<MessageV2.RetryPart, "error"> & { error: Pick<MessageV2.RetryPart["error"], "name"> })
    | Exclude<
        MessageV2.Part,
        | MessageV2.TextPart
        | MessageV2.ReasoningPart
        | MessageV2.ToolPart
        | MessageV2.CompactionRecoveryPart
        | MessageV2.RetryPart
      >
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
    token?: string
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
  const encode = (text: string) => new TextEncoder().encode(text)
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff

  function header(value: PartContent.Stored): Header {
    if (value.type === "text" || value.type === "reasoning") {
      if ("text" in value) {
        const { text: _text, ...header } = value
        return header
      }
      const { textContent: _content, ...header } = value
      return header
    }
    if (value.type === "compaction_recovery") {
      const { summary: _summary, ...rest } = value
      return rest
    }
    if (value.type === "retry") return { ...value, error: { name: value.error.name } }
    if (value.type !== "tool") return value
    const tool = value.state
    if (tool.status === "pending" || tool.status === "generating") {
      const { input: _input, raw: _raw, ...state } = tool
      return { ...value, state }
    }
    if (tool.status === "completed") {
      const { input: _input, output: _output, ...state } = tool
      return { ...value, state }
    }
    if (tool.status === "error") {
      const { input: _input, error: _error, ...state } = tool
      return { ...value, state }
    }
    const { input: _input, ...state } = tool
    return { ...value, state }
  }

  async function* utf8(blocks: AsyncIterable<string> | Iterable<string>) {
    let pending = ""
    for await (const block of blocks) {
      let text = pending + block
      pending = ""
      if (high(text.charCodeAt(text.length - 1))) {
        pending = text.slice(-1)
        text = text.slice(0, -1)
      }
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 16 * 1024)
        if (end < text.length && high(text.charCodeAt(end - 1))) end--
        yield encode(text.slice(offset, end))
        offset = end
      }
    }
    if (pending) yield encode(pending)
  }

  function* quoted(text: string): Generator<string> {
    yield '"'
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 16 * 1024)
      if (end < text.length && high(text.charCodeAt(end - 1))) end--
      yield JSON.stringify(text.slice(offset, end)).slice(1, -1)
      offset = end
    }
    yield '"'
  }

  function* json(value: unknown): Generator<string> {
    if (typeof value === "string") {
      yield* quoted(value)
      return
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      yield JSON.stringify(value)
      return
    }
    if (Array.isArray(value)) {
      yield "["
      for (let index = 0; index < value.length; index++) {
        if (index) yield ","
        yield* json(value[index])
      }
      yield "]"
      return
    }
    if (value && typeof value === "object") {
      yield "{"
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (!first) yield ","
        first = false
        yield* quoted(key)
        yield ":"
        yield* json(Reflect.get(value, key))
      }
      yield "}"
      return
    }
    throw new StorageIntegrityError("Tool input is not canonical JSON")
  }

  function text(field: Field, value: string, original: Source["original"] = "complete"): Source {
    return { field, original, mediaType: "text/plain;charset=utf-8", stream: () => utf8([value]) }
  }

  function artifact(field: Field, owner: RolloutSchema.Owner, ref: RolloutSchema.ArtifactRef): Source {
    return {
      field,
      token: JSON.stringify(ref),
      bytes: ref.bytes,
      sha256: ref.sha256 ?? undefined,
      mediaType: ref.mediaType,
      original: ref.status,
      stream: (signal) =>
        (async function* () {
          for await (const bytes of RolloutArtifact.read(owner, ref)) {
            signal?.throwIfAborted()
            yield bytes
          }
        })(),
    }
  }

  async function toolInput(key: string[], part: MessageV2.ToolPart, signal?: AbortSignal) {
    const info = await MessageV2.readInfo({ scopeID: key[1], sessionID: part.sessionID, messageID: part.messageID })
    if (info.role !== "assistant") return
    const rootID = info.rootID ?? info.parentID
    const owner = { kind: "session" as const, scopeID: key[1], sessionID: part.sessionID }
    signal?.throwIfAborted()
    const selected = await RolloutLedger.toolForPart(owner, {
      runID: rootID,
      messageID: part.messageID,
      toolCallID: part.callID,
      tool: part.tool,
    })
    return selected && artifact("input", owner, selected.input)
  }

  async function sources(key: string[], value: PartContent.Stored, signal?: AbortSignal): Promise<Source[]> {
    if (value.type === "text" || value.type === "reasoning")
      return [
        {
          field: "text",
          mediaType: "text/plain;charset=utf-8",
          original: "complete",
          stream: (signal) => utf8(PartContent.textBlocks(key, value, signal)),
        },
      ]
    if (value.type === "compaction_recovery") return [text("text", value.summary)]
    if (value.type !== "tool") return []
    const state = value.state
    if (state.status === "pending" || state.status === "generating")
      return [
        { ...text("input", state.raw, "partial"), mediaType: "application/json" },
        text("raw", state.raw, "partial"),
      ]
    const input = (await toolInput(key, value, signal)) ?? {
      field: "input" as const,
      original: "complete" as const,
      mediaType: "application/json",
      stream: () => utf8(json(state.input)),
    }
    const result = [input]
    if (state.status === "error") result.push(text("error", state.error))
    if (state.status !== "completed") return result
    const owner = { kind: "session" as const, scopeID: key[1], sessionID: value.sessionID }
    const missingOriginal =
      state.metadata.rolloutImportMissingOutput === true || state.metadata.rolloutLegacyOutput === "missing"
    if (state.outputArtifact && !missingOriginal) {
      result.push(artifact("output", owner, state.outputArtifact))
      return result
    }
    const reference = state.metadata.outputPath
    if (state.outputTruncated && typeof reference === "string") {
      const retained = await StoredToolOutput.open(reference).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (retained) {
        result.push({
          field: "output",
          mediaType: "text/plain;charset=utf-8",
          original: "complete",
          bytes: retained.bytes,
          sha256: retained.sha256,
          stream: retained.stream,
        })
        return result
      }
    }
    if (state.outputArtifact) {
      result.push({ ...artifact("output", owner, state.outputArtifact), original: "partial" })
      return result
    }
    result.push(text("output", state.output, state.outputTruncated ? "partial" : "complete"))
    return result
  }

  async function capture(key: string[], signal?: AbortSignal) {
    return Storage.snapshot(async (tx) => {
      signal?.throwIfAborted()
      const record = await tx.versioned<PartContent.Stored>(key)
      if (record.value.sessionID !== key[2] || record.value.messageID !== key[4] || record.value.id !== key[6])
        throw new StorageIntegrityError("Native Part field belongs to another record")
      const selected = await sources(key, record.value, signal)
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            selected.map((source) => [
              source.field,
              source.token,
              source.bytes,
              source.sha256,
              source.mediaType,
              source.original,
            ]),
          ),
        )
        .digest("hex")
      const version = "part-field:1:" + record.revision.toString() + ":" + digest
      return { version, header: header(record.value), sources: selected }
    })
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
