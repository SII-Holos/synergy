import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import type { Migration } from "../migration"
import { LibraryDB } from "./database"
import { Intent } from "./intent"
import { Log } from "../util/log"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"

import { MigrationRegistry } from "../migration/registry"
type SqliteConn = Database

type LegacyMemoryRow = {
  id: string
  title: string
  content: string
  category: string
  recall_mode: string | null
}

const log = Log.create({ service: "library.migration" })

async function exists(filepath: string): Promise<boolean> {
  return Bun.file(filepath).exists()
}

async function renameIfSafe(from: string, to: string): Promise<boolean> {
  if (!(await exists(from))) return false
  if (await exists(to)) {
    log.warn("library migration target already exists; leaving legacy path in place", { from, to })
    return false
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
  log.info("renamed legacy library path", { from, to })
  return true
}

async function migrateStorageSnapshot(): Promise<boolean> {
  const oldKey = ["engram", "stats", "snapshot"]
  const newKey = StoragePath.librarySnapshot()
  const oldSnapshot = await Storage.read<unknown>(oldKey).catch(() => undefined)
  if (oldSnapshot === undefined) return false

  const newSnapshot = await Storage.read<unknown>(newKey).catch(() => undefined)
  if (newSnapshot === undefined) {
    await Storage.write(newKey, oldSnapshot)
  }
  await Storage.remove(oldKey)
  log.info("migrated legacy library stats snapshot storage key")
  return true
}

async function migrateLibraryDataPath(): Promise<number> {
  const oldDB = path.join(Global.Path.root, "data", "engram.db")
  const oldDebug = path.join(Global.Path.root, "data", "engram")
  let changed = 0

  for (const suffix of ["", "-wal", "-shm"]) {
    if (await renameIfSafe(`${oldDB}${suffix}`, `${Global.Path.libraryDB}${suffix}`)) changed++
  }
  if (await renameIfSafe(oldDebug, Global.Path.libraryDebug)) changed++
  if (await migrateStorageSnapshot()) changed++
  return changed
}

function hasColumn(conn: SqliteConn, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

function inferMigratedMemory(
  title: string,
  content: string,
): { category: LibraryDB.Memory.Category; recallMode: LibraryDB.Memory.RecallMode } {
  const text = `${title}\n${content}`.toLowerCase()

  if (/(address|addressing|tone|language|style|wording|phrasing|speak|voice|respond|reply|communication)/.test(text)) {
    return { category: "interaction", recallMode: "always" }
  }

  if (/(coding|code|comments|tests|testing|commit|debug|refactor|typescript|javascript|bun|sqlite|api)/.test(text)) {
    return { category: "coding", recallMode: "contextual" }
  }

  if (
    /(writing|write|docs|documentation|prose|essay|article|draft|copy|tone for writing|voice for writing)/.test(text)
  ) {
    return { category: "writing", recallMode: "contextual" }
  }

  if (/(food|music|game|gaming|life|personal|like|likes|dislike|hobby|hobbies|favorite|favourite)/.test(text)) {
    return { category: "personal", recallMode: "search_only" }
  }

  return { category: "workflow", recallMode: "contextual" }
}

function defaultRecallMode(category: LibraryDB.Memory.Category): LibraryDB.Memory.RecallMode {
  if (["user", "self", "relationship", "interaction"].includes(category)) return "always"
  if (category === "personal" || category === "general") return "search_only"
  return "contextual"
}

function migrateMemoryRows(conn: SqliteConn) {
  const rows = conn.prepare("SELECT id, title, content, category, recall_mode FROM memory").all() as LegacyMemoryRow[]
  const categories = new Set<string>(LibraryDB.Memory.CATEGORIES)
  const recallModes = new Set<string>(LibraryDB.Memory.RECALL_MODES)
  const contextualLegacyCategories = new Set(["asset", "insight", "knowledge"])
  const alwaysLegacyCategories = new Set(["user", "self", "relationship"])

  for (const row of rows) {
    let category = row.category
    let recallMode = row.recall_mode

    if (!categories.has(category)) {
      if (category === "preference") {
        const migrated = inferMigratedMemory(row.title, row.content)
        category = migrated.category
        recallMode = migrated.recallMode
      } else if (alwaysLegacyCategories.has(category)) {
        recallMode = "always"
      } else if (contextualLegacyCategories.has(category)) {
        recallMode = "contextual"
      } else if (category === "general") {
        recallMode = "search_only"
      } else {
        const migrated = inferMigratedMemory(row.title, row.content)
        category = migrated.category
        recallMode = migrated.recallMode
      }
    }

    if (!categories.has(category)) {
      category = inferMigratedMemory(row.title, row.content).category
    }

    if (!recallMode || !recallModes.has(recallMode)) {
      recallMode = defaultRecallMode(category as LibraryDB.Memory.Category)
    }

    conn.prepare("UPDATE memory SET category = ?1, recall_mode = ?2 WHERE id = ?3").run(category, recallMode, row.id)
  }
}

export const migrations: Migration[] = [
  {
    id: "20260301-library-data-path",
    description: "Rename legacy engram database and stats paths to library paths",
    async up(progress) {
      progress(0, 1)
      await migrateLibraryDataPath()
      progress(1, 1)
    },
  },
  {
    id: "20260324-library-experience-source-model",
    description: "Add source model fields to experience records",
    async up(progress) {
      const conn = LibraryDB.connection()
      progress(1, 3)
      if (!hasColumn(conn, "experience", "source_provider_id")) {
        conn.exec("ALTER TABLE experience ADD COLUMN source_provider_id TEXT")
        log.info("added column", { table: "experience", column: "source_provider_id" })
      }

      progress(2, 3)
      if (!hasColumn(conn, "experience", "source_model_id")) {
        conn.exec("ALTER TABLE experience ADD COLUMN source_model_id TEXT")
        log.info("added column", { table: "experience", column: "source_model_id" })
      }

      progress(3, 3)
    },
  },
  {
    id: "20260405-library-memory-recall-mode",
    description: "Migrate memory category and recall mode fields",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      if (!hasColumn(conn, "memory", "recall_mode")) {
        conn.exec("ALTER TABLE memory ADD COLUMN recall_mode TEXT NOT NULL DEFAULT 'contextual'")
        log.info("added column", { table: "memory", column: "recall_mode" })
      }

      progress(2, 3)
      migrateMemoryRows(conn)

      progress(3, 3)
    },
  },
  {
    id: "20260415-library-purge-invalid-experiences",
    description: "Remove experiences with empty, junk, or malformed intents",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, intent, reward_status FROM experience").all() as {
        id: string
        intent: string
        reward_status: string
      }[]

      progress(2, 3)
      let removed = 0
      for (const row of rows) {
        if (!Intent.isValid(row.intent)) {
          LibraryDB.Experience.remove(row.id)
          removed++
        }
      }

      progress(3, 3)
      if (removed > 0) log.info("purged invalid experiences", { removed })
    },
  },
  {
    id: "20260423-library-purge-tool-hallucination-intents",
    description: "Remove experiences whose intent is a tool-call hallucination ([Tool: ...])",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, intent FROM experience WHERE intent LIKE '[Tool:%'").all() as {
        id: string
        intent: string
      }[]

      progress(2, 3)
      for (const row of rows) {
        LibraryDB.Experience.remove(row.id)
      }

      progress(3, 3)
      if (rows.length > 0) log.info("purged tool-hallucination intents", { removed: rows.length })
    },
  },
  {
    id: "20260424-library-q-updated-at-integer",
    description: "Convert q_updated_at from ISO text to epoch milliseconds integer",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, q_updated_at FROM experience WHERE q_updated_at IS NOT NULL").all() as {
        id: string
        q_updated_at: string
      }[]

      progress(2, 3)
      const stmt = conn.prepare("UPDATE experience SET q_updated_at = ?1 WHERE id = ?2")
      for (const row of rows) {
        const ms = new Date(row.q_updated_at).getTime()
        if (Number.isNaN(ms)) {
          log.warn("unparseable q_updated_at, setting to NULL", { id: row.id, value: row.q_updated_at })
          stmt.run(null, row.id)
        } else {
          stmt.run(ms, row.id)
        }
      }

      progress(3, 3)
      if (rows.length > 0) log.info("migrated q_updated_at to integer", { count: rows.length })
    },
  },
  {
    id: "20260425-library-purge-oversized-tool-log-intents",
    description: "Remove experiences with oversized intents containing tool output or logs",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, intent FROM experience WHERE LENGTH(intent) > 1000").all() as {
        id: string
        intent: string
      }[]

      progress(2, 3)
      let removed = 0
      for (const row of rows) {
        if (!Intent.isValid(row.intent)) {
          LibraryDB.Experience.remove(row.id)
          removed++
        }
      }

      progress(3, 3)
      if (removed > 0) log.info("purged oversized/tool-log experiences", { removed, scanned: rows.length })
    },
  },
  {
    id: "20260425b-library-purge-assistant-reasoning-intents",
    description: "Remove experiences whose intent is assistant reasoning rather than a compact user intent",
    async up(progress) {
      const conn = LibraryDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, intent FROM experience").all() as {
        id: string
        intent: string
      }[]

      progress(2, 3)
      let removed = 0
      for (const row of rows) {
        if (!Intent.isValid(row.intent)) {
          LibraryDB.Experience.remove(row.id)
          removed++
        }
      }

      progress(3, 3)
      if (removed > 0) log.info("purged assistant-reasoning intents", { removed, scanned: rows.length })
    },
  },
]
MigrationRegistry.register("library", migrations)
