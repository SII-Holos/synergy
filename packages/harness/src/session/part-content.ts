import { z } from "zod"
import { MARKDOWN_ASSET_REFERENCE_CHARS, markdownAssetReferences } from "@ericsanchezok/synergy-util/markdown-assets"
import { reasoningItemKey } from "@ericsanchezok/synergy-util/reasoning-item"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageCommitUnknownError, StorageConflictError, StorageIntegrityError } from "../storage/errors"
import type { StoreTransaction } from "../storage/transactional-store"
import { MessageV2 } from "./message-v2"

export namespace PartContent {
  export type Streaming = MessageV2.TextPart | MessageV2.ReasoningPart
  export type Header = Omit<MessageV2.TextPart, "text"> | Omit<MessageV2.ReasoningPart, "text">
  // Provenance: ../../test/session/streaming-persistence.test.ts, short-checkpoint work bound.
  // Local adaptation: avoid artifact publication for small bodies; spill the bounded prefix only once.
  const INLINE_CODE_UNITS = 4096
  const Facts = z.object({
    preview: z.string().max(256),
    nonempty: z.boolean(),
    jsonBytes: z.number().int().nonnegative(),
    references: z.string().max(256).array().max(32),
  })
  const Checkpoint = Facts.extend({
    version: z.literal(1),
    generation: z.string().uuid(),
    chunks: z.number().int().nonnegative(),
    codeUnits: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    inline: z.string().max(INLINE_CODE_UNITS).optional(),
    receipt: z.object({ operationID: z.string().uuid(), requestHash: z.string().length(64) }).optional(),
  })
  export type Checkpoint = z.infer<typeof Checkpoint>
  export type Stored = MessageV2.Part | (Header & { textContent: Checkpoint })
  export const ExecutionFact = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.enum([
      "text",
      "reasoning",
      "attachment",
      "tool",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "retry",
      "compaction",
      "compaction_recovery",
    ]),
    origin: z.enum(["user", "system"]).optional(),
    checkpoint: z.literal(true).optional(),
    preview: z.string().max(240),
    tool: z.string().optional(),
    callID: z.string().optional(),
    status: z.enum(["pending", "generating", "running", "completed", "error"]).optional(),
    time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
    accounting: z.object({ kind: z.literal("rollout"), callIDs: z.string().array() }).optional(),
  })
  export type ExecutionFact = z.infer<typeof ExecutionFact>

  export function executionFact(value: Stored, preparedPreview?: string): ExecutionFact | undefined {
    let text = ""
    const content = checkpoint(value)
    if (content && preparedPreview === undefined) {
      if (content.inline !== undefined) text = content.inline
      else {
        const normalized = content.preview.replace(/\s+/g, " ")
        if (normalized.length < 240 && content.preview.length < content.codeUnits) return
        text = content.preview
      }
    } else if (!content && (value.type === "text" || value.type === "reasoning")) text = (value as Streaming).text
    else if (value.type === "tool")
      text = value.state.status === "completed" ? value.state.title : JSON.stringify(value.state.input ?? {})
    else if (value.type === "attachment") text = value.filename ?? value.mime
    const time =
      value.type === "tool"
        ? "time" in value.state
          ? value.state.time
          : undefined
        : "time" in value
          ? value.time
          : undefined
    return ExecutionFact.parse({
      id: value.id,
      sessionID: value.sessionID,
      messageID: value.messageID,
      type: value.type,
      origin: value.type === "text" ? (MessageV2.isSystemPart(value) ? "system" : "user") : undefined,
      checkpoint: value.type === "patch" && value.checkpoint ? true : undefined,
      preview: preparedPreview ?? text.replace(/\s+/g, " ").slice(0, 240),
      tool: value.type === "tool" ? value.tool : undefined,
      callID: value.type === "tool" ? value.callID : undefined,
      status: value.type === "tool" ? value.state.status : undefined,
      time: time && "start" in time ? time : undefined,
      accounting: value.type === "step-finish" && value.accounting?.kind === "rollout" ? value.accounting : undefined,
    })
  }
  export type Batch = {
    header: Header
    text: string
    offset: number
    checkpoint: Checkpoint
    operationID: string
    sequence?: number
    prefix?: string
    requestHash?: string
  }

  export function checkpoint(value: Stored): Checkpoint | undefined {
    if (!("textContent" in value)) return
    const parsed = Checkpoint.safeParse(value.textContent)
    if (!parsed.success || !["text", "reasoning"].includes(value.type) || "text" in value)
      throw new StorageIntegrityError("Invalid or unsupported streaming Part content")
    return parsed.data
  }

  export function summary(value: Stored): MessageV2.PartSummary {
    const content = checkpoint(value)
    if (!content) return MessageV2.summarizePart(value as MessageV2.Part)
    const { textContent: _, ...header } = value as Header & { textContent: Checkpoint }
    return describe(header, content)
  }

  function describe(header: Header, content: Checkpoint): MessageV2.PartSummary {
    return {
      id: header.id,
      sessionID: header.sessionID,
      messageID: header.messageID,
      type: header.type,
      preview: content.preview,
      render:
        (header.type !== "text" || !MessageV2.isSystemPart(header)) &&
        (header.type !== "reasoning" || content.nonempty),
      reasoningKey: header.type === "reasoning" ? reasoningItemKey(header.metadata) : undefined,
      get references() {
        if (header.type !== "text" || MessageV2.isSystemPart(header)) return undefined
        const references = content.references
        return references.length ? references : undefined
      },
      content: {
        version: `part-content:1:${content.generation}:${content.revision}`,
        bytes: Buffer.byteLength(JSON.stringify({ ...header, text: "" })) + content.jsonBytes,
      },
    }
  }

  export async function hydrate(key: string[], value: Stored): Promise<MessageV2.Part> {
    const content = checkpoint(value)
    if (!content) return value as MessageV2.Part
    if (!Storage.inTransaction()) throw new StorageConflictError("Part hydration requires its source snapshot")
    const { textContent: _, ...header } = value as Header & { textContent: Checkpoint }
    if (content.inline !== undefined) {
      if (content.chunks !== 0 || content.inline.length !== content.codeUnits)
        throw new StorageIntegrityError("Streaming Part inline content does not match its checkpoint")
      return { ...header, text: content.inline } as Streaming
    }
    const chunks: string[] = []
    let codeUnits = 0
    for (let sequence = 0; sequence < content.chunks; sequence++) {
      let bytes: Uint8Array
      try {
        bytes = await Storage.readBinary(StoragePath.partContentChunk(key, content.generation, sequence))
      } catch (error) {
        if (error instanceof Storage.NotFoundError)
          throw new StorageIntegrityError("Streaming Part content is missing a committed chunk", { cause: error })
        throw error
      }
      if (bytes.length % 2) throw new StorageIntegrityError("Streaming Part content has an incomplete UTF-16 code unit")
      codeUnits += bytes.length / 2
      chunks.push(Buffer.from(bytes).toString("utf16le"))
    }
    if (codeUnits !== content.codeUnits)
      throw new StorageIntegrityError("Streaming Part content length does not match its checkpoint")
    return { ...header, text: chunks.join("") } as Streaming
  }

  export function read(key: string[]) {
    return Storage.snapshot(async (tx) => {
      const record = await tx.versioned<Stored>(key)
      return {
        part: await hydrate(key, record.value),
        summary: summary(record.value),
        revision: record.revision,
        checkpoint: checkpoint(record.value),
      }
    })
  }

  async function* textBlocks(key: string[], value: Stored, signal?: AbortSignal) {
    const content = checkpoint(value)
    if (!content) {
      if (value.type === "text" || value.type === "reasoning") yield (value as Streaming).text
      return
    }
    if (content.inline !== undefined) {
      if (content.chunks !== 0 || content.inline.length !== content.codeUnits)
        throw new StorageIntegrityError("Streaming Part inline content does not match its checkpoint")
      yield content.inline
      return
    }
    let codeUnits = 0
    for (let sequence = 0; sequence < content.chunks; sequence++) {
      signal?.throwIfAborted()
      const bytes = await Storage.readBinary(StoragePath.partContentChunk(key, content.generation, sequence)).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError)
            throw new StorageIntegrityError("Streaming Part content is missing a committed chunk", { cause: error })
          throw error
        },
      )
      if (bytes.length % 2) throw new StorageIntegrityError("Streaming Part content has an incomplete UTF-16 code unit")
      codeUnits += bytes.length / 2
      if (codeUnits > content.codeUnits)
        throw new StorageIntegrityError("Streaming Part content exceeds its checkpoint")
      yield Buffer.from(bytes).toString("utf16le")
    }
    if (codeUnits !== content.codeUnits)
      throw new StorageIntegrityError("Streaming Part content length does not match its checkpoint")
  }

  export async function prefix(
    sources: ReadonlyArray<{ key: string[]; value: Stored }>,
    options: {
      maxLength: number
      separator?: string
      normalizeWhitespace?: boolean
      trim?: boolean
      signal?: AbortSignal
    },
  ) {
    if (Storage.inTransaction())
      throw new StorageConflictError("Part prefixes must be read outside a storage transaction")
    if (!Number.isInteger(options.maxLength) || options.maxLength <= 0) throw new RangeError("Invalid prefix length")
    let output = ""
    let started = false
    let whitespace = false
    const append = (block: string) => {
      if (options.normalizeWhitespace) {
        const normalized = block.replace(/\s+/g, " ")
        block = whitespace && normalized.startsWith(" ") ? normalized.slice(1) : normalized
        if (normalized.length) whitespace = normalized.endsWith(" ")
      }
      if (!started && options.trim !== false) block = block.trimStart()
      if (!block.length) return false
      started = true
      const remaining = options.maxLength - output.length
      output += block.slice(0, remaining)
      return (
        output.length === options.maxLength &&
        (options.trim === false || /\S$/.test(output) || /\S/.test(block.slice(remaining)))
      )
    }
    for (let index = 0; index < sources.length; index++) {
      options.signal?.throwIfAborted()
      if (index && append(options.separator ?? "")) return output
      const source = sources[index]
      for await (const block of textBlocks(source.key, source.value, options.signal)) if (append(block)) return output
    }
    return options.trim === false ? output : output.trimEnd()
  }

  export async function assertOwner(tx: StoreTransaction, key: string[]) {
    await tx.read([...key.slice(0, 3), "info"])
    await tx.read([...key.slice(0, 5), "info"])
    await tx.assertNotDeleted(key)
  }

  export async function append(
    key: string[],
    batch: Batch,
    commitGuard: () => void,
    written: (value: Stored) => Promise<void>,
  ) {
    const before = await Storage.versioned<Stored>(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    const previous = before && checkpoint(before.value)
    const continuing = previous?.generation === batch.checkpoint.generation
    batch.sequence ??= continuing ? previous.chunks : 0
    batch.prefix ??= continuing ? (previous.inline ?? "") : ""
    const inline =
      batch.sequence === 0 && batch.checkpoint.codeUnits <= INLINE_CODE_UNITS ? batch.prefix + batch.text : undefined
    const bytes = inline === undefined ? Buffer.from(batch.prefix + batch.text, "utf16le") : Buffer.alloc(0)
    const blocks: Uint8Array[] = []
    for (let offset = 0; offset < bytes.length; offset += 2 * 1024 * 1024)
      blocks.push(bytes.subarray(offset, offset + 2 * 1024 * 1024))
    const content: Checkpoint = {
      ...batch.checkpoint,
      chunks: batch.sequence + blocks.length,
      ...(inline !== undefined && { inline }),
    }
    const value: Stored = { ...batch.header, textContent: content }
    batch.requestHash ??= new Bun.CryptoHasher("sha256")
      .update(JSON.stringify({ key, value, offset: batch.offset, sequence: batch.sequence }))
      .update(bytes)
      .digest("hex")
    content.receipt = { operationID: batch.operationID, requestHash: batch.requestHash }
    const prepared: Storage.PreparedBinary[] = []
    try {
      for (const [index, block] of blocks.entries())
        prepared.push(
          await Storage.prepareBinary(
            StoragePath.partContentChunk(key, batch.checkpoint.generation, batch.sequence + index),
            block,
          ),
        )
      await Storage.transaction(
        async (tx) => {
          await assertOwner(tx, key)
          const [current] = await tx.readMany<Stored>([key])
          const content = current && checkpoint(current)
          if (content?.receipt?.operationID === batch.operationID) {
            if (content.receipt.requestHash !== batch.requestHash)
              throw new StorageIntegrityError("Streaming Part operation receipt does not match its append")
            return
          }
          if (
            batch.offset !== (content?.generation === batch.checkpoint.generation ? content.codeUnits : 0) ||
            batch.sequence !== (content?.generation === batch.checkpoint.generation ? content.chunks : 0)
          )
            throw new StorageConflictError("Streaming Part checkpoint no longer matches its append")
          if (content && content.generation !== batch.checkpoint.generation)
            await tx.removeTree(StoragePath.partContent(key))
          for (const token of prepared) await Storage.publishPreparedBinary(token)
          await tx.write(key, value)
          await written(value)
        },
        { commitGuard },
      )
    } catch (error) {
      if (!(error instanceof StorageCommitUnknownError)) throw error
      const receipt = checkpoint(await Storage.read<Stored>(key))?.receipt
      if (receipt?.operationID !== batch.operationID) throw error
      if (receipt.requestHash !== batch.requestHash)
        throw new StorageIntegrityError("Streaming Part operation receipt does not match its append")
    } finally {
      for (const token of prepared) token[Symbol.dispose]()
    }
  }

  export async function replace(key: string[], value: MessageV2.Part) {
    await Storage.transaction(async (tx) => {
      await assertOwner(tx, key)
      const [previous] = await tx.readMany<Stored>([key])
      if (previous && checkpoint(previous)) await tx.removeTree(StoragePath.partContent(key))
      await tx.write(key, value)
    })
  }

  export function remove(key: string[]) {
    return Storage.removeTree(key)
  }

  export class Stream {
    readonly generation = crypto.randomUUID()
    private revision = 0
    private codeUnits = 0
    private jsonBytes = 0
    private last = 0
    private preview = ""
    private nonempty = false
    private readonly references = new ReferenceScan()

    append(header: Header, delta: string): Checkpoint {
      this.revision++
      this.jsonBytes += Buffer.byteLength(JSON.stringify(delta)) - 2
      if (this.last >= 0xd800 && this.last <= 0xdbff && delta.charCodeAt(0) >= 0xdc00 && delta.charCodeAt(0) <= 0xdfff)
        this.jsonBytes -= 8
      if (delta.length) this.last = delta.charCodeAt(delta.length - 1)
      this.codeUnits += delta.length
      this.preview += delta.slice(0, 256 - this.preview.length)
      this.nonempty ||= delta.trim().length > 0
      if (header.type === "text" && !MessageV2.isSystemPart(header)) this.references.append(delta)
      const references = this.references.snapshot()
      return {
        version: 1,
        generation: this.generation,
        chunks: 0,
        revision: this.revision,
        codeUnits: this.codeUnits,
        jsonBytes: this.jsonBytes,
        preview: this.preview,
        nonempty: this.nonempty,
        get references() {
          return references()
        },
      }
    }

    summary(header: Header, checkpoint: Checkpoint) {
      return describe(header, checkpoint)
    }
  }

  class ReferenceScan {
    private captured = 0
    private source = ""
    private tail = ""
    private hasAsset = false
    private read: () => string[] = () => []

    append(delta: string) {
      const captured = delta.slice(0, MARKDOWN_ASSET_REFERENCE_CHARS - this.captured)
      if (!captured.length) return
      this.captured += captured.length
      this.source += captured
      const suffix = this.tail + captured
      this.hasAsset ||= suffix.includes("asset://")
      this.tail = suffix.slice(-7)
      const source = this.source
      let references: string[] | undefined
      this.read = this.hasAsset ? () => (references ??= markdownAssetReferences(source)) : () => []
      if (this.captured === MARKDOWN_ASSET_REFERENCE_CHARS) {
        this.source = ""
        this.tail = ""
      }
    }

    snapshot() {
      return this.read
    }
  }
}
