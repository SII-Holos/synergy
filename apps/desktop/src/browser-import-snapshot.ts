import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { BrowserImportFailure, browserImportFailure } from "./browser-import-diagnostics.js"

export type BrowserImportDatabase = { prepare(sql: string): { all(): unknown[] }; close(): void }
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const ATTEMPTS = 3
const suffixes = ["", "-journal", "-wal"] as const

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function metadata(file: string) {
  try {
    const info = await lstat(file, { bigint: true })
    if (!info.isFile()) throw new BrowserImportFailure("unavailable", "snapshot")
    if (info.size > MAX_FILE_BYTES) throw new BrowserImportFailure("limit", "snapshot")
    return info
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

async function copySource(
  file: string,
  directory: string,
  validate: (file: string) => Promise<void>,
  signal: AbortSignal,
) {
  const files: Array<{ source: string; suffix: string; info?: BigIntStats; handle?: FileHandle }> = []
  try {
    let total = 0n
    for (const suffix of suffixes) {
      signal.throwIfAborted()
      const source = file + suffix
      const info = await metadata(source)
      const item = { source, suffix, info, handle: undefined as FileHandle | undefined }
      files.push(item)
      if (!info) {
        if (!suffix) throw new BrowserImportFailure("unavailable", "snapshot")
        continue
      }
      total += info.size
      if (total > MAX_SNAPSHOT_BYTES) throw new BrowserImportFailure("limit", "snapshot")
      await validate(source)
      item.handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!sameFile(info, await item.handle.stat({ bigint: true }))) throw new BrowserImportFailure("busy", "snapshot")
    }
    for (const item of files) {
      if (!item.info || !item.handle) continue
      const destination = await open(path.join(directory, "database" + item.suffix), "wx", 0o600)
      const buffer = Buffer.alloc(1024 * 1024)
      try {
        let position = 0
        const size = Number(item.info.size)
        while (position < size) {
          signal.throwIfAborted()
          const { bytesRead } = await item.handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
          if (!bytesRead) throw new BrowserImportFailure("busy", "snapshot")
          let written = 0
          while (written < bytesRead) {
            const result = await destination.write(buffer, written, bytesRead - written, position + written)
            if (!result.bytesWritten) throw new BrowserImportFailure("unavailable", "snapshot")
            written += result.bytesWritten
          }
          position += bytesRead
        }
      } finally {
        buffer.fill(0)
        await destination.close()
      }
    }
    for (const item of files) {
      signal.throwIfAborted()
      const after = await metadata(item.source)
      if (!item.info && !after) continue
      if (
        !item.info ||
        !after ||
        !sameFile(item.info, after) ||
        !sameFile(item.info, await item.handle!.stat({ bigint: true }))
      )
        throw new BrowserImportFailure("busy", "snapshot")
      await validate(item.source)
    }
  } finally {
    await Promise.all(files.map((item) => item.handle?.close()))
  }
}

// Provenance: https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active
// Local adaptation: copy stable database/journal/WAL files, recover only the private copy, then check integrity before querying.
export async function readBrowserSnapshot<T>(input: {
  file: string
  signal: AbortSignal
  validate(file: string): Promise<void>
  openDatabase(file: string): Promise<BrowserImportDatabase>
  read(db: BrowserImportDatabase): Promise<T>
}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    input.signal.throwIfAborted()
    const directory = await mkdtemp(path.join(tmpdir(), "synergy-browser-import-"))
    let db: BrowserImportDatabase | undefined
    let stage: "snapshot" | "integrity" | "query" = "snapshot"
    try {
      await copySource(input.file, directory, input.validate, input.signal)
      input.signal.throwIfAborted()
      stage = "integrity"
      db = await input.openDatabase(path.join(directory, "database"))
      const check = db.prepare("PRAGMA quick_check(1)").all()
      if (
        check.length !== 1 ||
        typeof check[0] !== "object" ||
        check[0] === null ||
        Object.values(check[0])[0] !== "ok"
      )
        throw new BrowserImportFailure("corrupt", stage)
      db.prepare("PRAGMA query_only = ON").all()
      db.prepare("BEGIN").all()
      input.signal.throwIfAborted()
      stage = "query"
      return await input.read(db)
    } catch (error) {
      input.signal.throwIfAborted()
      const failure = browserImportFailure(error, stage)
      if (attempt === ATTEMPTS || stage === "query" || (failure.code !== "busy" && failure.code !== "corrupt"))
        throw new BrowserImportFailure(failure.code, failure.stage, attempt, failure.sqliteCode)
    } finally {
      try {
        db?.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    await setTimeout(100 * attempt, undefined, { signal: input.signal })
  }
  throw new BrowserImportFailure("busy", "snapshot", ATTEMPTS)
}
