import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StorageConflictError, StorageIntegrityError } from "../storage/errors"
import type { StoreTransaction } from "../storage/transactional-store"
import { MessageV2 } from "./message-v2"
import { PartContent } from "./part-content"
import { RolloutArtifact } from "./rollout/artifact"
import { RolloutToolPartIndex } from "./rollout/tool-part-index"
import { StoredToolOutput } from "../tool/stored-output"
import type { Migration } from "../migration/types"
import { UpgradeWork } from "../storage/upgrade-work"

export namespace SessionPartFieldSource {
  export const PAGE_BYTES = 16 * 1024
  const identity = { id: z.string().max(256), sessionID: z.string().max(256), messageID: z.string().max(256) }
  const time = z.strictObject({ start: z.number(), end: z.number().optional() })
  const scalar = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()])
  const metadata = z
    .record(z.string().max(128), scalar)
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192)
  export const Header = z
    .discriminatedUnion("type", [
      z.strictObject({
        ...identity,
        type: z.literal("text"),
        origin: z.enum(["user", "system"]),
        time: time.optional(),
      }),
      z.strictObject({ ...identity, type: z.literal("reasoning"), time }),
      z.strictObject({
        ...identity,
        type: z.literal("tool"),
        callID: z.string().max(256),
        tool: z.string().max(256),
        state: z.strictObject({
          status: z.enum(["pending", "generating", "running", "completed", "error"]),
          title: z.string().max(1024).optional(),
          time: time.optional(),
          metadata: metadata.optional(),
        }),
      }),
      z.strictObject({
        ...identity,
        type: z.literal("attachment"),
        filename: z.string().max(512).optional(),
        mime: z.string().max(256),
        artifact: RolloutArtifact.Ref.optional(),
      }),
      z.strictObject({ ...identity, type: z.literal("step-start") }),
      z.strictObject({
        ...identity,
        type: z.literal("step-finish"),
        reason: z.string().max(1024),
        cost: z.number(),
        tokens: z.lazy(() => MessageV2.StepFinishPart.shape.tokens),
      }),
      z.strictObject({ ...identity, type: z.literal("compaction"), auto: z.boolean() }),
      z.strictObject({
        ...identity,
        type: z.literal("compaction_recovery"),
        mechanical: z.boolean(),
        validated: z.boolean(),
      }),
      z.strictObject({ ...identity, type: z.literal("retry"), error: z.strictObject({ name: z.string().max(256) }) }),
      z.strictObject({ ...identity, type: z.enum(["patch", "snapshot", "unavailable"]) }),
    ])
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024)
  export type Header = z.infer<typeof Header>
  const common = {
    field: z.enum(["text", "raw", "input", "output", "error"]),
    mediaType: z.string().max(256),
    original: z.enum(["complete", "partial"]),
  }
  const Reference = RolloutArtifact.Ref.omit({ mediaType: true }).extend({ mediaTypeHash: z.string().length(64) })
  const artifact = (field: "input" | "output", reference: RolloutArtifact.Ref, original = reference.status): Source => {
    const { mediaType, ...retained } = reference
    return Source.parse({
      kind: "artifact",
      field,
      reference: { ...retained, mediaTypeHash: createHash("sha256").update(mediaType).digest("hex") },
      mediaType: mediaType.length <= 256 ? mediaType : "application/octet-stream",
      original,
    })
  }
  const Chunks = z
    .strictObject({
      ...common,
      kind: z.literal("chunks"),
      slot: common.field,
      bytes: z.number().int().nonnegative().safe(),
      sha256: z.string().length(64),
      pages: z.number().int().nonnegative().safe(),
    })
    .refine((value) => value.pages === Math.ceil(value.bytes / PAGE_BYTES))
  export const Source = z.discriminatedUnion("kind", [
    z.strictObject({ ...common, kind: z.literal("artifact"), reference: Reference }),
    Chunks,
    z.strictObject({ ...common, kind: z.literal("tool-input"), query: RolloutToolPartIndex.Locator, fallback: Chunks }),
    z.strictObject({ ...common, kind: z.literal("checkpoint"), value: z.lazy(() => PartContent.Checkpoint) }),
    z.strictObject({
      ...common,
      kind: z.literal("stored"),
      reference: z.string().max(4096),
      bytes: z.number().int().nonnegative().safe(),
      sha256: z.string().length(64),
    }),
  ])
  export type Source = z.infer<typeof Source>
  export type ResolvedSource = Exclude<Source, { kind: "tool-input" }>
  const Projection = z
    .strictObject({
      version: z.literal(1),
      revision: z.string().regex(/^\d+$/),
      header: Header,
      fields: z.array(Source).max(5),
    })
    .refine((value) => new Set(value.fields.map((field) => field.field)).size === value.fields.length)
  const Chunk = z.strictObject({
    bytes: z.number().int().positive().max(PAGE_BYTES),
    sha256: z.string().length(64),
    data: z
      .string()
      .regex(/^[A-Za-z0-9_-]*$/)
      .max(Math.ceil((PAGE_BYTES * 4) / 3)),
  })
  const root = (key: string[]) => [...key.slice(0, 3), "part_field_sources", key[4], key[6]]
  const headerKey = (key: string[]) => [...root(key), "header"]
  const chunkKey = (key: string[], field: string, page: number) => [
    ...root(key),
    "fields",
    field,
    String(page).padStart(16, "0"),
  ]
  const version = (revision: string, fields: ResolvedSource[]) =>
    `part-field:2:${revision}:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`

  function safeMetadata(value: Record<string, unknown> | undefined) {
    if (!value) return
    const selected: Record<string, z.infer<typeof scalar>> = {}
    let bytes = 2
    let count = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key) || key.length > 128) continue
      const raw = scalar.safeParse(value[key])
      if (!raw.success) continue
      const size = Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(raw.data)) + 2
      if (bytes + size > 8192) continue
      Object.defineProperty(selected, key, { value: raw.data, enumerable: true })
      bytes += size
      if (++count === 64) break
    }
    return count ? selected : undefined
  }
  function header(value: PartContent.Stored): Header {
    const base = { id: value.id, sessionID: value.sessionID, messageID: value.messageID }
    const present = (raw: unknown): Header => {
      const selected = Header.safeParse(raw)
      return selected.success ? selected.data : Header.parse({ ...base, type: "unavailable" })
    }
    switch (value.type) {
      case "text":
        return present({
          ...base,
          type: value.type,
          origin: MessageV2.isSystemPart(value) ? "system" : "user",
          time: value.time,
        })
      case "reasoning":
        return present({ ...base, type: value.type, time: value.time })
      case "tool": {
        const state = value.state
        return present({
          ...base,
          type: value.type,
          callID: value.callID,
          tool: value.tool,
          state: {
            status: state.status,
            title: "title" in state ? (state.title && state.title.length <= 1024 ? state.title : undefined) : undefined,
            time:
              "time" in state
                ? { start: state.time.start, end: "end" in state.time ? state.time.end : undefined }
                : undefined,
            metadata: safeMetadata(state.metadata),
          },
        })
      }
      case "attachment":
        return present({
          ...base,
          type: value.type,
          filename: value.filename
            ?.slice(Math.max(value.filename.lastIndexOf("/"), value.filename.lastIndexOf("\\")) + 1)
            .slice(0, 512),
          mime: value.mime,
          artifact: value.artifact,
        })
      case "step-finish":
        return present({
          ...base,
          type: value.type,
          reason: value.reason,
          cost: value.cost,
          tokens: value.tokens,
        })
      case "compaction":
        return present({ ...base, type: value.type, auto: value.auto })
      case "compaction_recovery":
        return present({ ...base, type: value.type, mechanical: value.mechanical, validated: value.validated })
      case "retry":
        return present({ ...base, type: value.type, error: { name: value.error.name } })
      default:
        return present({ ...base, type: value.type })
    }
  }
  function assertKey(key: string[]) {
    if (key.length !== 7 || key[0] !== "sessions" || key[3] !== "messages" || key[5] !== "parts")
      throw new StorageIntegrityError("Native field sources require a canonical Session Part")
  }
  export function remove(tx: StoreTransaction, key: string[]) {
    assertKey(key)
    return tx.removeTree(root(key))
  }

  async function* utf8(blocks: Iterable<string> | AsyncIterable<string>) {
    let pending = ""
    for await (const block of blocks) {
      let text = pending + block
      pending = ""
      const last = text.charCodeAt(text.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        pending = text.slice(-1)
        text = text.slice(0, -1)
      }
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + PAGE_BYTES / 4)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
        yield Buffer.from(text.slice(offset, end))
        offset = end
      }
    }
    if (pending) yield Buffer.from(pending)
  }
  function* json(value: unknown): Generator<string> {
    if (typeof value === "string") {
      yield '"'
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(value.length, offset + PAGE_BYTES / 4)
        const code = value.charCodeAt(end - 1)
        if (end < value.length && code >= 0xd800 && code <= 0xdbff) end--
        yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
        offset = end
      }
      yield '"'
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
        yield* json(key)
        yield ":"
        yield* json(Reflect.get(value, key))
      }
      yield "}"
      return
    }
    throw new StorageIntegrityError("Native field input is not canonical JSON")
  }
  async function chunks(
    tx: StoreTransaction,
    key: string[],
    field: Source["field"],
    blocks: Iterable<string>,
    original: Source["original"] = "complete",
    mediaType = "text/plain;charset=utf-8",
  ): Promise<z.infer<typeof Chunks>> {
    const hash = createHash("sha256")
    const buffer = new Uint8Array(PAGE_BYTES)
    let filled = 0
    let pages = 0
    let bytes = 0
    async function flush() {
      if (!filled) return
      UpgradeWork.signal()?.throwIfAborted()
      const data = buffer.subarray(0, filled)
      await tx.write(
        chunkKey(key, field, pages++),
        Chunk.parse({
          bytes: filled,
          sha256: createHash("sha256").update(data).digest("hex"),
          data: Buffer.from(data).toString("base64url"),
        }),
      )
      filled = 0
    }
    for await (const block of utf8(blocks)) {
      hash.update(block)
      bytes += block.byteLength
      for (let offset = 0; offset < block.byteLength;) {
        const count = Math.min(PAGE_BYTES - filled, block.byteLength - offset)
        buffer.set(block.subarray(offset, offset + count), filled)
        offset += count
        filled += count
        if (filled === PAGE_BYTES) await flush()
      }
    }
    await flush()
    return Chunks.parse({
      kind: "chunks",
      field,
      slot: field,
      bytes,
      pages,
      sha256: hash.digest("hex"),
      mediaType,
      original,
    })
  }
  async function toolInput(key: string[], part: MessageV2.ToolPart) {
    const info = await MessageV2.readInfo({ scopeID: key[1], sessionID: part.sessionID, messageID: part.messageID })
    if (info.role !== "assistant") return
    return RolloutToolPartIndex.locator({
      runID: info.rootID ?? info.parentID,
      messageID: part.messageID,
      toolCallID: part.callID,
      tool: part.tool,
    })
  }
  export async function capture(
    tx: StoreTransaction,
    key: string[],
    producer: PartContent.Stored,
    expectedRevision?: bigint,
  ) {
    assertKey(key)
    if (producer.id !== key[6] || producer.messageID !== key[4] || producer.sessionID !== key[2])
      throw new StorageIntegrityError("Native field producer belongs to another canonical record")
    // Producer values can have stateful toJSON; only this transaction's encoded record is canonical.
    const record = await tx.versioned<unknown>(key)
    const revision = record.revision
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw new StorageConflictError("Native field producer changed during capture")
    const value = Stored.parse(record.value)
    if (value.id !== key[6] || value.messageID !== key[4] || value.sessionID !== key[2])
      throw new StorageIntegrityError("Native field record belongs to another canonical producer")
    await remove(tx, key)
    const fields: Source[] = []
    if (value.type === "text" || value.type === "reasoning") {
      const checkpoint = PartContent.checkpoint(value)
      fields.push(
        checkpoint
          ? Source.parse({
              kind: "checkpoint",
              field: "text",
              value: checkpoint,
              mediaType: "text/plain;charset=utf-8",
              original: "complete",
            })
          : await chunks(tx, key, "text", ["text" in value ? value.text : ""]),
      )
    } else if (value.type === "compaction_recovery") fields.push(await chunks(tx, key, "text", [value.summary]))
    else if (value.type === "tool") {
      const state = value.state
      if (state.status === "pending" || state.status === "generating") {
        const input = await chunks(tx, key, "input", [state.raw], "partial", "application/json")
        fields.push(input, Source.parse({ ...input, field: "raw", mediaType: "text/plain;charset=utf-8" }))
      } else {
        const query = await toolInput(key, value)
        const fallback = await chunks(tx, key, "input", json(state.input), "complete", "application/json")
        fields.push(
          query
            ? Source.parse({
                kind: "tool-input",
                field: "input",
                query,
                fallback,
                mediaType: "application/json",
                original: "complete",
              })
            : fallback,
        )
        if (state.status === "error") fields.push(await chunks(tx, key, "error", [state.error]))
        if (state.status === "completed") {
          const missingOriginal =
            state.metadata.rolloutImportMissingOutput === true || state.metadata.rolloutLegacyOutput === "missing"
          if (state.outputArtifact && !missingOriginal) fields.push(artifact("output", state.outputArtifact))
          else {
            const path = state.metadata.outputPath
            const retained =
              state.outputTruncated && typeof path === "string"
                ? await StoredToolOutput.open(path).catch((error) => {
                    if (error instanceof Storage.NotFoundError) return
                    throw error
                  })
                : undefined
            if (retained)
              fields.push(
                Source.parse({
                  kind: "stored",
                  field: "output",
                  reference: retained.reference,
                  bytes: retained.bytes,
                  sha256: retained.sha256,
                  mediaType: "text/plain;charset=utf-8",
                  original: "complete",
                }),
              )
            else if (state.outputArtifact) fields.push(artifact("output", state.outputArtifact, "partial"))
            else
              fields.push(
                await chunks(tx, key, "output", [state.output], state.outputTruncated ? "partial" : "complete"),
              )
          }
        }
      }
    }
    await tx.write(
      headerKey(key),
      Projection.parse({ version: 1, revision: String(revision), header: header(value), fields }),
    )
  }

  const Stored = z.lazy(() =>
    z.union([
      MessageV2.Part,
      MessageV2.TextPart.omit({ text: true }).extend({ textContent: PartContent.Checkpoint }),
      MessageV2.ReasoningPart.omit({ text: true }).extend({ textContent: PartContent.Checkpoint }),
    ]),
  )
  export function captureRecord(tx: StoreTransaction, key: string[], raw: unknown, revision?: bigint) {
    return capture(tx, key, Stored.parse(raw), revision)
  }

  async function migrate(
    owner: { scopeID: string; sessionID: string },
    progress: (current: number, total: number) => void,
  ) {
    let after: string[] | undefined
    let count = 0
    for (;;) {
      UpgradeWork.signal()?.throwIfAborted()
      const keys = await Storage.queryKeys({
        kind: "part",
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        after,
        limit: 32,
      })
      const canonical = keys.filter((key) => key.length === 7)
      const pending = await Storage.snapshot(async (tx) => {
        const [rows, revisions] = await Promise.all([tx.readMany(canonical.map(headerKey)), tx.revisions(canonical)])
        return canonical.filter((_key, index) => {
          const raw = rows[index]
          if (raw === undefined) return true
          const current = Projection.safeParse(raw)
          if (!current.success)
            throw new StorageIntegrityError("Native field projection version is invalid or unsupported")
          return current.data.revision !== String(revisions[index])
        })
      })
      for (const key of pending) {
        UpgradeWork.signal()?.throwIfAborted()
        const record = await Storage.versioned(key)
        await Storage.transaction((tx) => captureRecord(tx, key, record.value, record.revision))
      }
      count += canonical.length
      progress(count, 0)
      if (keys.length < 32) break
      after = keys.at(-1)
    }
    progress(count, count)
  }
  export const migration: Migration = {
    id: "20261112-session-native-field-sources",
    scope: "session",
    execution: "session",
    dependsOn: ["20261112-rollout-session-input-locators"],
    description: "Prepare bounded native field headers and immutable sources beside canonical Part revisions",
    upSession: migrate,
    async up(progress) {
      let count = 0
      for await (const record of Storage.records<{ scope: { id: string }; id: string }>({
        kind: "session",
        limit: 32,
      })) {
        await migrate({ scopeID: record.value.scope.id, sessionID: record.value.id }, () => {})
        progress(++count, 0)
      }
      progress(count, count)
    },
  }

  async function resolve(key: string[], expected: z.infer<typeof Reference>) {
    const owner = { kind: "session" as const, scopeID: key[1], sessionID: key[2] }
    const selected = await RolloutArtifact.get(owner, expected.id)
    const { mediaType, ...retained } = selected
    if (
      JSON.stringify({ ...retained, mediaTypeHash: createHash("sha256").update(mediaType).digest("hex") }) !==
      JSON.stringify(expected)
    )
      throw new StorageIntegrityError("Native field artifact disagrees with its producer")
    return selected
  }
  export async function* stream(
    key: string[],
    source: ResolvedSource,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (source.kind === "artifact") {
      for await (const bytes of RolloutArtifact.read(
        { kind: "session", scopeID: key[1], sessionID: key[2] },
        await resolve(key, source.reference),
      )) {
        signal?.throwIfAborted()
        yield bytes
      }
      return
    }
    if (source.kind === "stored") {
      const selected = await StoredToolOutput.open(source.reference)
      if (selected.bytes !== source.bytes || selected.sha256 !== source.sha256)
        throw new StorageIntegrityError("Native field source changed")
      yield* selected.stream(signal)
      return
    }
    if (source.kind === "checkpoint") {
      const selected = await get(key, signal)
      if (selected.header.type !== "text" && selected.header.type !== "reasoning")
        throw new StorageIntegrityError("Native text field has another producer")
      const text = PartContent.textBlocks(key, { ...selected.header, textContent: source.value }, signal)
      yield* utf8(text)
      return
    }
    for (let page = 0; page < source.pages; page++) {
      signal?.throwIfAborted()
      yield await readChunk(key, source, page)
    }
  }
  async function readChunk(key: string[], source: Extract<Source, { kind: "chunks" }>, page: number) {
    const selected = Chunk.parse(await Storage.read(chunkKey(key, source.slot, page)))
    const bytes = Buffer.from(selected.data, "base64url")
    const expected = Math.min(PAGE_BYTES, source.bytes - page * PAGE_BYTES)
    if (
      selected.bytes !== expected ||
      bytes.byteLength !== selected.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== selected.sha256 ||
      source.pages !== Math.ceil(source.bytes / PAGE_BYTES)
    )
      throw new StorageIntegrityError("Native field source chunk is invalid")
    return bytes
  }
  export async function range(key: string[], source: Source, offset: number, length: number, signal?: AbortSignal) {
    if (source.kind !== "chunks" && source.kind !== "artifact") return
    const total = source.kind === "artifact" ? source.reference.bytes : source.bytes
    if (offset > total) throw new RangeError("Native field offset is out of range")
    const bytes = new Uint8Array(Math.min(length, total - offset))
    if (source.kind === "artifact") {
      const owner = { kind: "session" as const, scopeID: key[1], sessionID: key[2] }
      const reference = await resolve(key, source.reference)
      for (let written = 0; written < bytes.byteLength;) {
        const block = await RolloutArtifact.readRange(
          owner,
          reference,
          offset + written,
          Math.min(65_536, bytes.byteLength - written),
          signal,
        )
        if (!block.byteLength) throw new StorageIntegrityError("Native field artifact range made no progress")
        bytes.set(block, written)
        written += block.byteLength
      }
      await resolve(key, source.reference)
      return bytes
    }
    for (let written = 0; written < bytes.byteLength;) {
      signal?.throwIfAborted()
      const start = offset + written
      const chunk = await readChunk(key, source, Math.floor(start / PAGE_BYTES))
      const selected = chunk.subarray(
        start % PAGE_BYTES,
        Math.min(chunk.byteLength, (start % PAGE_BYTES) + bytes.byteLength - written),
      )
      bytes.set(selected, written)
      written += selected.byteLength
    }
    return bytes
  }

  export async function get(key: string[], signal?: AbortSignal) {
    assertKey(key)
    return Storage.snapshot(async (tx) => {
      signal?.throwIfAborted()
      const [[raw], [revision]] = await Promise.all([tx.readMany([headerKey(key)]), tx.revisions([key])])
      if (raw === undefined || revision === undefined)
        throw new Storage.NotFoundError({ message: "Native field sources are unavailable" })
      const parsed = Projection.parse(raw)
      if (parsed.revision !== String(revision))
        throw new StorageConflictError("Native field sources disagree with the producer revision")
      if (parsed.header.id !== key[6] || parsed.header.messageID !== key[4] || parsed.header.sessionID !== key[2])
        throw new StorageIntegrityError("Native field sources belong to another producer")
      const fields = await Promise.all(
        parsed.fields.map(async (source): Promise<ResolvedSource> => {
          if (source.kind !== "tool-input") return source
          const selected = await RolloutToolPartIndex.input(
            { kind: "session", scopeID: key[1], sessionID: key[2] },
            source.query,
          )
          if (!selected) return source.fallback
          return {
            kind: "artifact",
            field: "input",
            reference: selected.reference,
            mediaType: selected.mediaType,
            original: selected.reference.status,
          }
        }),
      )
      return { ...parsed, fields, version: version(parsed.revision, fields) }
    })
  }
}
