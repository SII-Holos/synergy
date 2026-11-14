import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Storage } from "../storage/storage"
import { StorageConflictError, StorageIntegrityError } from "../storage/errors"
import type { StoreTransaction } from "../storage/transactional-store"
import type { Migration } from "../migration/types"
import { UpgradeWork } from "../storage/upgrade-work"
import type { PartContent } from "./part-content"
import { RolloutArtifact } from "./rollout/artifact"
import { MessageV2 } from "./message-v2"
import { attachmentPurpose } from "@ericsanchezok/synergy-util/attachment-presentation"

export namespace SessionAttachmentIndex {
  export const Conflict = NamedError.create("SessionAttachmentIndexConflict", z.object({ message: z.string() }))
  const LegacyHeader = z.strictObject({
    version: z.literal(1),
    revision: z.string().regex(/^\d+$/),
    kind: z.enum(["tool", "attachment"]),
    count: z.number().int().nonnegative().safe(),
  })
  const Header = LegacyHeader.extend({
    version: z.literal(2),
    kind: z.enum(["tool", "attachment", "other"]),
    visibleCount: z.number().int().nonnegative().safe(),
  }).refine(
    (value) => value.visibleCount <= value.count && (value.kind !== "other" || value.count === 0),
    "Attachment counts disagree with the producer",
  )
  const Row = z.strictObject({
    ordinal: z.number().int().nonnegative().safe(),
    filename: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(256),
    artifact: RolloutArtifact.Ref.optional(),
    hidden: z.boolean(),
    purpose: z.enum(["evidence", "deliverable"]),
  })
  export type Row = z.infer<typeof Row>
  export const Query = z.strictObject({
    cursor: z.string().max(8192).optional(),
    limit: z.number().int().min(1).max(32).default(32),
  })
  export type Query = z.input<typeof Query>
  const Cursor = z.strictObject({
    version: z.literal(2),
    key: z.array(z.string()).length(7),
    revision: z.string().regex(/^\d+$/),
    after: z.number().int().nonnegative().safe(),
  })
  const root = (key: string[]) => [...key.slice(0, 3), "attachment_index", key[4], key[6]]
  const headerKey = (key: string[]) => [...root(key), "header"]
  const rows = (key: string[]) => [...root(key), "rows"]
  const rowKey = (key: string[], ordinal: number) => [...rows(key), String(ordinal).padStart(16, "0")]
  const version = (revision: string) => `part-attachments:1:${revision}`

  export interface Page {
    version: string
    total: number
    items: { ordinal: number; filename: string; mediaType: string; bytes?: number }[]
    cursor?: string
  }
  function assertKey(key: string[]) {
    if (key.length !== 7 || key[0] !== "sessions" || key[3] !== "messages" || key[5] !== "parts")
      throw new StorageIntegrityError("Attachment index requires a canonical Session Part")
  }
  export function remove(tx: StoreTransaction, key: string[]) {
    assertKey(key)
    return tx.removeTree(root(key))
  }
  export async function captureRecord(tx: StoreTransaction, key: string[], raw: unknown) {
    const value = z
      .object({ type: z.string(), id: z.string(), sessionID: z.string(), messageID: z.string() })
      .parse(raw)
    assertKey(key)
    if (value.id !== key[6] || value.sessionID !== key[2] || value.messageID !== key[4])
      throw new StorageIntegrityError("Attachment producer belongs to another canonical Part")
    if (value.type !== "attachment" && value.type !== "tool") {
      const [revision] = await tx.revisions([key])
      if (revision === undefined) throw new Storage.NotFoundError({ message: "Attachment producer is unavailable" })
      await remove(tx, key)
      return tx.write(
        headerKey(key),
        Header.parse({ version: 2, kind: "other", revision: String(revision), count: 0, visibleCount: 0 }),
      )
    }
    return capture(tx, key, MessageV2.Part.parse(raw))
  }
  export async function capture(
    tx: StoreTransaction,
    key: string[],
    part: PartContent.Stored,
    expectedRevision?: bigint,
  ) {
    assertKey(key)
    if (part.sessionID !== key[2] || part.messageID !== key[4] || part.id !== key[6])
      throw new StorageIntegrityError("Attachment index belongs to another Session Part")
    const [revision] = await tx.revisions([key])
    if (revision === undefined || (expectedRevision !== undefined && revision !== expectedRevision))
      throw new StorageConflictError("Canonical attachment producer changed during preparation")
    await tx.removeTree(root(key))
    if (part.type !== "tool" && part.type !== "attachment")
      return tx.write(
        headerKey(key),
        Header.parse({ version: 2, kind: "other", revision: String(revision), count: 0, visibleCount: 0 }),
      )
    const files =
      part.type === "attachment" ? [part] : part.state.status === "completed" ? (part.state.attachments ?? []) : []
    for (let offset = 0; offset < files.length; offset += 128) {
      UpgradeWork.signal()?.throwIfAborted()
      await tx.writeMany(
        files.slice(offset, offset + 128).map((file, index) => {
          const name = (file.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment"
          const filename = name === "." || name === ".." ? "attachment" : name.slice(0, 512)
          return {
            key: rowKey(key, offset + index),
            value: Row.parse({
              ordinal: offset + index,
              filename,
              mediaType: file.artifact?.mediaType ?? file.mime,
              artifact: file.artifact,
              hidden: file.presentation?.hidden ?? false,
              purpose: attachmentPurpose(file),
            }),
          }
        }),
      )
    }
    await tx.write(
      headerKey(key),
      Header.parse({
        version: 2,
        revision: String(revision),
        kind: part.type,
        count: files.length,
        visibleCount: files.reduce((count, file) => count + (file.presentation?.hidden ? 0 : 1), 0),
      }),
    )
  }
  async function current(tx: StoreTransaction, key: string[], signal?: AbortSignal) {
    assertKey(key)
    signal?.throwIfAborted()
    const [revision] = await tx.revisions([key])
    if (revision === undefined) throw new Storage.NotFoundError({ message: "Attachment producer is unavailable" })
    const [raw] = await tx.readMany([headerKey(key)])
    if (raw === undefined) throw new Storage.NotFoundError({ message: "Attachment metadata is unavailable" })
    const header = Header.parse(raw)
    if (header.revision !== String(revision))
      throw new Conflict({ message: "Attachment producer changed; refresh its metadata" })
    return header
  }
  export async function assertVersion(key: string[], input: string, signal?: AbortSignal) {
    return Storage.snapshot(async (tx) => {
      const header = await current(tx, key, signal)
      if (input !== version(header.revision))
        throw new Conflict({ message: "Attachment producer changed; refresh its metadata" })
    })
  }
  export async function get(key: string[], input: { version: string; ordinal: number }, signal?: AbortSignal) {
    return Storage.snapshot(async (tx) => {
      const header = await current(tx, key, signal)
      if (input.version !== version(header.revision))
        throw new Conflict({ message: "Attachment producer changed; refresh its metadata" })
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= header.count)
        throw new Storage.NotFoundError({ message: "Attachment ordinal is unavailable" })
      const row = Row.parse(await tx.read(rowKey(key, input.ordinal)))
      signal?.throwIfAborted()
      if (row.ordinal !== input.ordinal)
        throw new StorageIntegrityError("Attachment metadata belongs to another ordinal")
      return row
    })
  }
  export async function page(key: string[], input: Query, signal?: AbortSignal): Promise<Page> {
    const query = Query.parse(input)
    return Storage.snapshot(async (tx) => {
      const header = await current(tx, key, signal)
      let after = -1
      if (query.cursor) {
        let cursor: z.infer<typeof Cursor>
        try {
          cursor = Cursor.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")))
        } catch {
          throw new Conflict({ message: "Attachment metadata cursor is invalid" })
        }
        if (
          JSON.stringify(cursor.key) !== JSON.stringify(key) ||
          cursor.revision !== header.revision ||
          cursor.after >= header.count
        )
          throw new Conflict({ message: "Attachment metadata cursor belongs to another producer or version" })
        after = cursor.after
      }
      const records = await tx.query<unknown>({
        prefix: rows(key),
        after: after < 0 ? undefined : rowKey(key, after),
        limit: query.limit,
      })
      signal?.throwIfAborted()
      const selected = records.map((record, offset) => {
        const row = Row.parse(record.value)
        if (
          row.ordinal !== after + offset + 1 ||
          JSON.stringify(record.key) !== JSON.stringify(rowKey(key, row.ordinal))
        )
          throw new StorageIntegrityError("Attachment metadata page is incomplete or has a foreign ordinal")
        return row
      })
      if (selected.length !== Math.min(query.limit, header.count - after - 1))
        throw new StorageIntegrityError("Attachment metadata page is missing committed rows")
      const items = selected.flatMap((row) =>
        row.hidden
          ? []
          : [
              {
                ordinal: row.ordinal,
                filename: row.filename,
                mediaType: row.mediaType,
                ...(row.artifact ? { bytes: row.artifact.bytes } : {}),
              },
            ],
      )
      const last = selected.at(-1)?.ordinal
      return {
        version: version(header.revision),
        total: header.visibleCount,
        items,
        ...(last !== undefined && last + 1 < header.count
          ? {
              cursor: Buffer.from(
                JSON.stringify(Cursor.parse({ version: 2, key, revision: header.revision, after: last })),
              ).toString("base64url"),
            }
          : {}),
      }
    })
  }

  async function migrate(
    owner: { scopeID: string; sessionID: string },
    progress: (current: number, total: number) => void,
  ) {
    let count = 0,
      after: string[] | undefined
    for (;;) {
      const keys = await Storage.queryKeys({
        kind: "part",
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        after,
        limit: 32,
      })
      const canonical = keys.filter((key) => key.length === 7)
      const pending = await Storage.snapshot(async (tx) => {
        const headers = await tx.readMany(canonical.map(headerKey))
        const revisions = await tx.revisions(canonical)
        return canonical.filter((_key, index) => {
          const raw = headers[index]
          if (raw === undefined) return true
          const current = Header.safeParse(raw)
          if (current.success) return current.data.revision !== String(revisions[index])
          if (!LegacyHeader.safeParse(raw).success)
            throw new StorageIntegrityError("Attachment metadata version is invalid or unsupported")
          return true
        })
      })
      for (const key of pending) {
        UpgradeWork.signal()?.throwIfAborted()
        const record = await Storage.versioned<PartContent.Stored>(key)
        const { SessionHistoryDisplay } = await import("./history-display")
        await Storage.transaction(async (tx) => {
          await capture(tx, key, record.value, record.revision)
          await SessionHistoryDisplay.refreshPart(owner.scopeID, record.value)
        })
      }
      count += canonical.length
      progress(count, 0)
      if (keys.length < 32) break
      after = keys.at(-1)
    }
    progress(count, count)
  }
  export const migration: Migration = {
    id: "20261112-session-attachment-metadata-pages",
    scope: "session",
    execution: "session",
    description: "Index exact native attachment producer metadata by Part revision and ordinal",
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
  export const presentationMigration: Migration = {
    ...migration,
    id: "20261112-session-attachment-presentation-pages-v2",
    description: "Rebuild attachment presentation metadata from canonical producers without adopting legacy rows",
    dependsOn: [migration.id],
  }
}
