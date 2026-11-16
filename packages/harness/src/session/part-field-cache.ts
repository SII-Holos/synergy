import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { Lock } from "../util/lock"
import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"

export namespace SessionPartFieldCache {
  export const PAGE_BYTES = 128 * 1024
  const State = z.strictObject({
    version: z.literal(1),
    nativeVersion: z.string(),
    generation: z.uuid(),
    pages: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().length(64),
    accessed: z.number(),
  })
  export type State = z.infer<typeof State>
  const Page = z.strictObject({ bytes: z.number().int().positive().max(PAGE_BYTES), sha256: z.string().length(64) })
  export interface Source {
    bytes?: number
    sha256?: string
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>
  }
  export const identity = (key: string[], field: string) =>
    createHash("sha256")
      .update(JSON.stringify([key, field]))
      .digest("hex")
  const root = (id: string) => ["part_field_cache", id]
  const stateKey = (id: string) => [...root(id), "current"]
  const generationKey = (id: string, generation: string) => [...root(id), "generations", generation]
  const pageKey = (id: string, generation: string, page: number) => [
    ...generationKey(id, generation),
    "pages",
    String(page).padStart(16, "0"),
  ]
  const lockKey = (id: string) => "part-field-cache:" + id
  const maintenance = RuntimeContext.state(() => ({
    controller: new AbortController(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    running: undefined as Promise<unknown> | undefined,
    after: undefined as string | undefined,
  }))

  async function state(id: string) {
    const value = await Storage.read(stateKey(id), { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    const parsed = State.safeParse(value)
    if (parsed.success && parsed.data.pages === Math.ceil(parsed.data.bytes / PAGE_BYTES)) return parsed.data
  }

  async function retireGeneration(id: string, generation: string, signal?: AbortSignal) {
    const prefix = generationKey(id, generation)
    let after: string[] | undefined
    for (;;) {
      signal?.throwIfAborted()
      const page = await Storage.artifactReferences({ prefix, after, limit: 64 })
      for (const entry of page) {
        signal?.throwIfAborted()
        await Storage.removeTree(entry.key)
      }
      if (page.length < 64) break
      after = page.at(-1)!.key
    }
    await Storage.removeTree(prefix)
  }

  async function retireOtherGenerations(id: string, keep?: string, signal?: AbortSignal) {
    let after: string | undefined
    for (;;) {
      signal?.throwIfAborted()
      const page = await Storage.childKeys({
        prefix: [...root(id), "generations"],
        includeBranches: true,
        after,
        limit: 64,
      })
      for (const key of page.keys) if (key.at(-1) !== keep) await retireGeneration(id, key.at(-1)!, signal)
      if (!page.after) return
      after = page.after
    }
  }

  export async function inspect(key: string[], field: string, nativeVersion: string) {
    const current = await state(identity(key, field))
    if (current?.nativeVersion === nativeVersion) return current
  }

  export async function prepare(input: {
    key: string[]
    field: string
    nativeVersion: string
    source: Source
    signal?: AbortSignal
    validate(): Promise<void>
    progress?(bytes: number): void
  }) {
    const id = identity(input.key, input.field)
    using lease = await Lock.write(lockKey(id))
    input.signal?.throwIfAborted()
    const current = await state(id)
    if (current?.nativeVersion === input.nativeVersion) return current
    await retireOtherGenerations(id, current?.generation, input.signal)
    const generation = crypto.randomUUID()
    await Storage.write([...generationKey(id, generation), "preparation"], {
      version: 1,
      nativeVersion: input.nativeVersion,
      started: Date.now(),
    })
    const hash = createHash("sha256")
    const buffer = new Uint8Array(PAGE_BYTES)
    let filled = 0
    let bytes = 0
    let pages = 0
    let published = false
    const flush = async () => {
      if (!filled) return
      input.signal?.throwIfAborted()
      const destination = pageKey(id, generation, pages++)
      const value = buffer.subarray(0, filled)
      const page = { bytes: filled, sha256: createHash("sha256").update(value).digest("hex") }
      using prepared = await Storage.prepareBinary(destination, value)
      await Storage.transaction(async () => {
        await Storage.publishPreparedBinary(prepared)
        await Storage.write(destination, page)
      })
      filled = 0
    }
    try {
      for await (const block of input.source.stream(input.signal)) {
        input.signal?.throwIfAborted()
        hash.update(block)
        bytes += block.length
        if (!Number.isSafeInteger(bytes))
          throw new StorageIntegrityError("Part field byte count exceeds a safe integer")
        for (let offset = 0; offset < block.length;) {
          const count = Math.min(PAGE_BYTES - filled, block.length - offset)
          buffer.set(block.subarray(offset, offset + count), filled)
          filled += count
          offset += count
          if (filled === PAGE_BYTES) await flush()
        }
        input.progress?.(bytes)
      }
      await flush()
      const sha256 = hash.digest("hex")
      if (
        (input.source.bytes !== undefined && input.source.bytes !== bytes) ||
        (input.source.sha256 !== undefined && input.source.sha256 !== sha256)
      )
        throw new StorageIntegrityError("Part field cache disagrees with native content evidence")
      await input.validate()
      input.signal?.throwIfAborted()
      const next = State.parse({
        version: 1,
        nativeVersion: input.nativeVersion,
        generation,
        pages,
        bytes,
        sha256,
        accessed: Date.now(),
      })
      await Storage.transaction(async () => {
        await Storage.write([...generationKey(id, generation), "manifest"], next)
        await Storage.write(stateKey(id), next)
        await Storage.remove([...generationKey(id, generation), "preparation"])
      })
      published = true
      await retireOtherGenerations(id, generation, input.signal)
      return next
    } finally {
      if (!published) await retireGeneration(id, generation)
    }
  }

  export async function read(input: {
    key: string[]
    field: string
    nativeVersion: string
    offset: number
    length: number
    signal?: AbortSignal
  }) {
    const id = identity(input.key, input.field)
    // One Runtime owns a Home. This lease covers publication, bounded reads and collection of its regenerable pages.
    using lease = await Lock.write(lockKey(id))
    input.signal?.throwIfAborted()
    const current = await state(id)
    if (!current || current.nativeVersion !== input.nativeVersion)
      throw new Storage.NotFoundError({ message: "Part field cache must be prepared for the current native version" })
    if (input.offset > current.bytes) throw new RangeError("Part field byte offset is out of range")
    const length = Math.min(input.length, current.bytes - input.offset)
    const data = new Uint8Array(length)
    const end = input.offset + length
    let copied = 0
    try {
      for (let page = Math.floor(input.offset / PAGE_BYTES); page * PAGE_BYTES < end; page++) {
        input.signal?.throwIfAborted()
        const destination = pageKey(id, current.generation, page)
        const expectedPage = Page.parse(await Storage.read(destination))
        const bytes = await Storage.readBinary(destination, { maxBytes: PAGE_BYTES })
        const expected = Math.min(PAGE_BYTES, current.bytes - page * PAGE_BYTES)
        if (
          bytes.length !== expected ||
          bytes.length !== expectedPage.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== expectedPage.sha256
        )
          throw new StorageIntegrityError("Part field cache page has an invalid length or checksum")
        const start = Math.max(0, input.offset - page * PAGE_BYTES)
        const until = Math.min(bytes.length, end - page * PAGE_BYTES)
        data.set(bytes.subarray(start, until), copied)
        copied += until - start
      }
    } catch (error) {
      if (
        error instanceof StorageIntegrityError ||
        error instanceof Storage.NotFoundError ||
        error instanceof z.ZodError
      ) {
        try {
          await Storage.remove(stateKey(id))
          await retireGeneration(id, current.generation)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Failed to retire invalid native field cache")
        }
      }
      throw error
    }
    if (Date.now() - current.accessed > 60_000) await Storage.write(stateKey(id), { ...current, accessed: Date.now() })
    return { ...current, data }
  }

  export async function sweep(input: { before?: number; after?: string; limit?: number; signal?: AbortSignal } = {}) {
    const before = input.before ?? Date.now() - 7 * 24 * 60 * 60_000
    let retired = 0
    input.signal?.throwIfAborted()
    const page = await Storage.childKeys({
      prefix: ["part_field_cache"],
      includeBranches: true,
      after: input.after,
      limit: input.limit ?? 64,
    })
    for (const key of page.keys) {
      input.signal?.throwIfAborted()
      const id = key.at(-1)!
      using lease = await Lock.write(lockKey(id))
      input.signal?.throwIfAborted()
      const current = await state(id)
      await retireOtherGenerations(
        id,
        current && current.accessed > before ? current.generation : undefined,
        input.signal,
      )
      if (!current || current.accessed <= before) {
        await Storage.remove(stateKey(id))
        retired++
      }
    }
    return { retired, after: page.after }
  }

  export async function collect(before = Date.now() - 7 * 24 * 60 * 60_000) {
    let after: string | undefined
    let retired = 0
    do {
      const result = await sweep({ before, after })
      retired += result.retired
      after = result.after
    } while (after)
    return retired
  }

  export function start() {
    const state = maintenance()
    if (state.timer || state.controller.signal.aborted) return
    const runtime = RuntimeContext.current()
    state.timer = setInterval(
      runtime.bind(() => {
        if (state.running || state.controller.signal.aborted) return
        const running = sweep({ after: state.after, signal: state.controller.signal }).then((result) => {
          state.after = result.after
        })
        state.running = running
        void running
          .catch((error) => {
            if (!state.controller.signal.aborted)
              Log.create({ service: "part-field-cache" }).error("Field cache collection failed", { error })
          })
          .finally(() => {
            state.running = undefined
          })
      }),
      15 * 60_000,
    )
    state.timer.unref?.()
  }

  export async function stop() {
    const state = maintenance()
    if (state.timer) clearInterval(state.timer)
    state.timer = undefined
    const reason = new Error("Runtime is closing field cache collection")
    state.controller.abort(reason)
    try {
      await state.running
    } catch (error) {
      if (error !== reason) throw error
    }
  }
}
