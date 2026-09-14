import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import path from "node:path"

let initialized = false
export function initializeSqliteEngine() {
  if (initialized) return
  if (process.platform === "darwin") {
    const packaged = path.resolve(path.dirname(process.execPath), "../libsqlite3.dylib")
    const source = path.resolve(import.meta.dirname, "../../.artifacts/sqlite/libsqlite3.dylib")
    const candidates = [packaged, source]
    // Source development can use a verified Homebrew engine; packaged builds
    // include their own engine and never depend on machine-wide libraries.
    if (existsSync(path.resolve(import.meta.dirname, "../../package.json")))
      candidates.push("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib")
    const selected = candidates.find(existsSync)
    if (!selected)
      throw new Error(
        "A patched SQLite engine is required. Run bun packages/harness/script/build-sqlite.ts for source development or reinstall the complete Synergy runtime.",
      )
    Database.setCustomSQLite(selected)
  }
  const probe = new Database(":memory:")
  try {
    const row = probe.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()!
    const [major, minor, patch] = row.version.split(".").map(Number)
    const supported =
      major === 3 &&
      (minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6))
    if (!supported)
      throw new Error(`SQLite ${row.version} lacks the required WAL reset fix; use a supported Synergy runtime`)
  } finally {
    probe.close()
  }
  initialized = true
}
