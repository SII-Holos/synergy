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
