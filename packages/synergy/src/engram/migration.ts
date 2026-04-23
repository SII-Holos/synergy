import { Database } from "bun:sqlite"
import type { Migration } from "../migration"
import { EngramDB } from "./database"
import { Intent } from "./intent"
import { Log } from "../util/log"

type SqliteConn = Database

type LegacyMemoryRow = {
  id: string
  title: string
  content: string
  category: string
  recall_mode: string | null
}

const log = Log.create({ service: "engram.migration" })

function hasColumn(conn: SqliteConn, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

function inferMigratedMemory(
  title: string,
  content: string,
): { category: EngramDB.Memory.Category; recallMode: EngramDB.Memory.RecallMode } {
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

function defaultRecallMode(category: EngramDB.Memory.Category): EngramDB.Memory.RecallMode {
  if (["user", "self", "relationship", "interaction"].includes(category)) return "always"
  if (category === "personal" || category === "general") return "search_only"
  return "contextual"
}

function migrateMemoryRows(conn: SqliteConn) {
  const rows = conn.prepare("SELECT id, title, content, category, recall_mode FROM memory").all() as LegacyMemoryRow[]
  const categories = new Set<string>(EngramDB.Memory.CATEGORIES)
  const recallModes = new Set<string>(EngramDB.Memory.RECALL_MODES)
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
      recallMode = defaultRecallMode(category as EngramDB.Memory.Category)
    }

    conn.prepare("UPDATE memory SET category = ?1, recall_mode = ?2 WHERE id = ?3").run(category, recallMode, row.id)
  }
}

export const migrations: Migration[] = [
  {
    id: "20260324-engram-experience-source-model",
    description: "Add source model fields to experience records",
    async up(progress) {
      const conn = EngramDB.connection()
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
    id: "20260405-engram-memory-recall-mode",
    description: "Migrate memory category and recall mode fields",
    async up(progress) {
      const conn = EngramDB.connection()

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
    id: "20260415-engram-purge-invalid-experiences",
    description: "Remove experiences with empty, junk, or malformed intents",
    async up(progress) {
      const conn = EngramDB.connection()

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
          EngramDB.Experience.remove(row.id)
          removed++
        }
      }

      progress(3, 3)
      if (removed > 0) log.info("purged invalid experiences", { removed })
    },
  },
  {
    id: "20260423-engram-purge-tool-hallucination-intents",
    description: "Remove experiences whose intent is a tool-call hallucination ([Tool: ...])",
    async up(progress) {
      const conn = EngramDB.connection()

      progress(1, 3)
      const rows = conn.prepare("SELECT id, intent FROM experience WHERE intent LIKE '[Tool:%'").all() as {
        id: string
        intent: string
      }[]

      progress(2, 3)
      for (const row of rows) {
        EngramDB.Experience.remove(row.id)
      }

      progress(3, 3)
      if (rows.length > 0) log.info("purged tool-hallucination intents", { removed: rows.length })
    },
  },
]
