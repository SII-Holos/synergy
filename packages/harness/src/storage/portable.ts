import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ArtifactLocation } from "./artifact-location"
import type { StoreTransaction, TransactionalStore } from "./transactional-store"
import { StorageIntegrityError } from "./errors"
import type { StorageStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"
import { observeStorageProgress } from "./progress"
import { StorageCompat } from "./compat"

export const StorageEntry = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("artifact"), key: z.array(z.string().min(1)).min(1), location: ArtifactLocation })
    .strict(),
  z
    .object({
      type: z.literal("record"),
      key: z.array(z.string().min(1)).min(1),
      value: z.unknown(),
      revision: z.string().regex(/^[1-9][0-9]*$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("receipt"),
      operationID: z.string(),
      requestHash: z.string(),
      result: z.string(),
      created: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      id: z.string(),
      scopeID: z.string(),
      eventType: z.string(),
      payload: z.unknown(),
    })
    .strict(),
])
export type StorageEntry = z.infer<typeof StorageEntry>
const Header = z
  .object({ format: z.literal("synergy-agent-data"), version: z.union([z.literal(1), z.literal(2)]) })
  .strict()
const Footer = z
  .object({ end: z.literal(true), count: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
// Record roots that carry grants, consent or trust decisions. Portable
// archives from another home must not pre-place them: an imported approval
// would suppress the consent prompt for a later plugin install. Same-home
// relocation (data move / target switch) is the only trusted transfer.
export const authorityRecordRoots = new Set([
  "plugin-approvals",
  "plugin-audit",
  "plugin-incompatible",
  "plugin-install-intents",
  "plugin-lock",
  "plugin-runtime-state",
  "permission-rules",
  "permissions",
  "registry",
])
const MAX_LINE_BYTES = 32 * 1024 * 1024

export namespace StoragePortable {
  export async function exportFile(store: TransactionalStore, filename: string) {
    await StorageCompat.assertConverged(store)
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.tmp-${randomUUID()}`
    const file = await fs.open(temporary, "wx", 0o600)
    let count = 0
    const hash = createHash("sha256")
    try {
      await file.writeFile(JSON.stringify({ format: "synergy-agent-data", version: 2 }) + "\n")
      await store.snapshot(async (tx) => {
        for await (const entry of tx.exportEntries()) {
          if ((entry.type === "record" || entry.type === "artifact") && entry.key[0] === "compat_import") continue
          const line = JSON.stringify(entry) + "\n"
          if (Buffer.byteLength(line) > MAX_LINE_BYTES)
            throw new StorageIntegrityError("Portable record exceeds the supported byte limit")
          hash.update(line)
          await file.writeFile(line)
          count++
        }
      })
      const sha256 = hash.digest("hex")
      await file.writeFile(JSON.stringify({ end: true, count, sha256 }) + "\n")
      await file.sync()
      await file.close()
      await fs.rename(temporary, filename)
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(filename), "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      return { count, sha256 }
    } catch (error) {
      await file.close().catch(() => {})
      await fs.rm(temporary, { force: true })
      throw error
    }
  }

  export async function importFile(
    store: TransactionalStore,
    filename: string,
    options: {
      accept?: (entry: StorageEntry, tx: StoreTransaction) => boolean | Promise<boolean>
      operationID?: string
      afterImport?: (tx: StoreTransaction) => Promise<void>
      progress?: (progress: StorageStartupProgress) => void
    } = {},
  ) {
    const fileHash = createHash("sha256")
    let bytes = 0
    options.progress?.({ stage: "archive-verify", current: 0, total: 0, bytes: 0 })
    for await (const chunk of createReadStream(filename)) {
      fileHash.update(chunk)
      bytes += Buffer.byteLength(chunk)
      options.progress?.({ stage: "archive-verify", current: bytes, total: 0, bytes })
    }
    const requestHash = fileHash.digest("hex")
    let work = 0
    let consumedBytes = 0
    options.progress?.({ stage: "archive-import", current: 0, total: 0, bytes: 0 })
    return observeStorageProgress(
      (record) =>
        store.transaction(
          async (tx) => {
            let count = 0
            let accepted = 0
            let header = false
            let footer = false
            const hash = createHash("sha256")
            const consumed = createHash("sha256")
            for await (const line of lines(filename)) {
              consumed.update(line + "\n")
              consumedBytes += Buffer.byteLength(line) + 1
              record({ stage: "archive-import", current: ++work, total: 0, bytes: consumedBytes })
              if (!header) {
                Header.parse(JSON.parse(line))
                header = true
                continue
              }
              if (footer) throw new StorageIntegrityError("Portable archive contains trailing data")
              const parsed: unknown = JSON.parse(line)
              if (parsed && typeof parsed === "object" && "end" in parsed) {
                const last = Footer.parse(parsed)
                if (last.count !== count || last.sha256 !== hash.digest("hex"))
                  throw new StorageIntegrityError("Portable archive checksum mismatch")
                footer = true
                continue
              }
              hash.update(line + "\n")
              count++
              const entry = StorageEntry.parse(parsed)
              if (options.accept && !(await options.accept(entry, tx))) continue
              await tx.restoreEntry(entry)
              accepted++
            }
            if (!header || !footer)
              throw new StorageIntegrityError("Portable archive is truncated; checksum footer is missing")
            if (consumed.digest("hex") !== requestHash)
              throw new StorageIntegrityError("Portable archive changed during import")
            await options.afterImport?.(tx)
            return { count, accepted, sha256: requestHash }
          },
          options.operationID ? { operationID: options.operationID, requestHash } : undefined,
        ),
      options.progress,
    )
  }
}

async function* lines(filename: string) {
  let remainder = ""
  for await (const chunk of createReadStream(filename, { encoding: "utf8", highWaterMark: 65536 })) {
    remainder += chunk
    let index: number
    while ((index = remainder.indexOf("\n")) !== -1) {
      const line = remainder.slice(0, index)
      if (Buffer.byteLength(line) > MAX_LINE_BYTES)
        throw new StorageIntegrityError("Portable record exceeds the supported byte limit")
      yield line
      remainder = remainder.slice(index + 1)
    }
    if (Buffer.byteLength(remainder) > MAX_LINE_BYTES)
      throw new StorageIntegrityError("Portable record exceeds the supported byte limit")
  }
  if (remainder) throw new StorageIntegrityError("Portable archive is truncated; final newline is missing")
}
