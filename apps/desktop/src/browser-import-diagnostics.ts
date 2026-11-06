import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import type { BrowserImportError, BrowserImportKind, BrowserImportSource } from "@ericsanchezok/synergy-browser-core"

type Stage = "access" | "snapshot" | "integrity" | "query" | "decrypt" | "complete"
export type BrowserImportDiagnostic = {
  browser: BrowserImportSource["browser"]
  kind: BrowserImportKind
  stage: Stage
  error?: BrowserImportError
  sqliteCode?: number
  attempt?: number
  rows?: number
  failed?: number
}

export class BrowserImportFailure extends Error {
  constructor(
    readonly code: BrowserImportError,
    readonly stage: Stage,
    readonly attempt?: number,
    readonly sqliteCode?: number,
  ) {
    super(code === "access" ? "Browser access was not granted." : `Browser import failed: ${code}.`)
  }
}

export function browserImportFailure(error: unknown, stage: Stage): BrowserImportFailure {
  if (error instanceof BrowserImportFailure) return error
  const data = error !== null && typeof error === "object" ? error : {}
  const code = "code" in data ? data.code : undefined
  const numeric = "errcode" in data ? data.errcode : "errno" in data ? data.errno : undefined
  const sqliteCode = typeof numeric === "number" && numeric > 0 && numeric < 65536 ? numeric & 255 : undefined
  if (code === "EACCES" || code === "EPERM") return new BrowserImportFailure("access", stage)
  if (sqliteCode === 5 || sqliteCode === 6 || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
    return new BrowserImportFailure("busy", stage, undefined, sqliteCode)
  if (sqliteCode === 11 || sqliteCode === 26 || code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB")
    return new BrowserImportFailure("corrupt", stage, undefined, sqliteCode)
  if (sqliteCode === 1 || code === "SQLITE_ERROR")
    return new BrowserImportFailure("unsupported", stage, undefined, sqliteCode)
  return new BrowserImportFailure("unavailable", stage, undefined, sqliteCode)
}

export function createBrowserImportLogger(directory: string) {
  return async (entry: BrowserImportDiagnostic) => {
    // Only fixed categories and aggregate counts cross this logging boundary.
    const { browser, kind, stage, error, sqliteCode, attempt, rows, failed } = entry
    const line = JSON.stringify({
      time: new Date().toISOString(),
      browser,
      kind,
      stage,
      error,
      sqliteCode,
      attempt,
      rows,
      failed,
    })
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = await open(path.join(directory, "browser-import.log"), "a", 0o600)
      try {
        await file.writeFile(line + "\n")
      } finally {
        await file.close()
      }
    } catch {
      console.warn("[browser-import] diagnostics unavailable")
    }
  }
}
