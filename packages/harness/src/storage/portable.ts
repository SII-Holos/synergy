import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { StoreTransaction, TransactionalStore } from "./transactional-store"
import { StorageIntegrityError } from "./errors"

export const StorageEntry = z.discriminatedUnion("type", [
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
const Header = z.object({ format: z.literal("synergy-agent-data"), version: z.literal(1) }).strict()
const Footer = z
  .object({ end: z.literal(true), count: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const MAX_LINE_BYTES = 32 * 1024 * 1024

export namespace StoragePortable {
  export async function exportFile(store: TransactionalStore, filename: string) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.tmp-${randomUUID()}`
    const file = await fs.open(temporary, "wx", 0o600)
    let count = 0
    const hash = createHash("sha256")
    try {
      await file.writeFile(JSON.stringify({ format: "synergy-agent-data", version: 1 }) + "\n")
      await store.snapshot(async (tx) => {
        for await (const entry of tx.exportEntries()) {
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
    } = {},
  ) {
    const fileHash = createHash("sha256")
    for await (const chunk of createReadStream(filename)) fileHash.update(chunk)
    const requestHash = fileHash.digest("hex")
    return store.transaction(
      async (tx) => {
        let count = 0
        let accepted = 0
        let header = false
        let footer = false
        const hash = createHash("sha256")
        const consumed = createHash("sha256")
        for await (const line of lines(filename)) {
          consumed.update(line + "\n")
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
