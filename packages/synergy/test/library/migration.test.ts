import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "bun:sqlite"
import { closeDB, LibraryDB } from "../../src/library/database"
import { migrations } from "../../src/library/migration"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function hasColumn(conn: Database, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

function hasTable(conn: Database, table: string): boolean {
  const row = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table)
  return row != null
}

function hasIndex(conn: Database, index: string): boolean {
  const row = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1").get(index)
  return row != null
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

describe.serial("library migrations", () => {
  beforeEach(() => {
    LibraryDB.Experience.removeAll()
    LibraryDB.Memory.removeAll()
  })

  afterAll(() => {
    closeDB()
  })

  describe("migration metadata", () => {
    test("each migration has a valid id and description", () => {
      for (const m of migrations) {
        expect(m.id).toBeTruthy()
        expect(m.description).toBeTruthy()
        expect(typeof m.up).toBe("function")
      }
    })

    test("migration ids are unique", () => {
      const ids = migrations.map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    test("migrations are sorted by id ascending", () => {
      const ids = migrations.map((m) => m.id)
      const sorted = [...ids].sort()
      expect(ids).toEqual(sorted)
    })
  })

  describe("hasColumn", () => {
    test("returns true for existing column", () => {
      const conn = LibraryDB.connection()
      expect(hasColumn(conn, "experience", "id")).toBe(true)
      expect(hasColumn(conn, "experience", "intent")).toBe(true)
      expect(hasColumn(conn, "memory", "id")).toBe(true)
    })

    test("returns false for non-existent column", () => {
      const conn = LibraryDB.connection()
      expect(hasColumn(conn, "experience", "nonexistent_column")).toBe(false)
      expect(hasColumn(conn, "memory", "imaginary_field")).toBe(false)
    })
  })

  describe("inferMigratedMemory", () => {
    test("interaction keywords map to interaction category", () => {
      const result = inferMigratedMemory("Communication style", "Respond in a friendly tone")
      expect(result.category).toBe("interaction")
      expect(result.recallMode).toBe("always")
    })

    test("coding keywords map to coding category", () => {
      const result = inferMigratedMemory("Coding preferences", "Use TypeScript for all API code")
      expect(result.category).toBe("coding")
      expect(result.recallMode).toBe("contextual")
    })

    test("writing keywords map to writing category", () => {
      const result = inferMigratedMemory("Drafting process", "Prose and essay writing conventions")
      expect(result.category).toBe("writing")
      expect(result.recallMode).toBe("contextual")
    })

    test("personal keywords map to personal category", () => {
      const result = inferMigratedMemory("Favorite food", "Likes pizza and pasta")
      expect(result.category).toBe("personal")
      expect(result.recallMode).toBe("search_only")
    })

    test("fallback maps to workflow category", () => {
      const result = inferMigratedMemory("Random note", "Something generic here")
      expect(result.category).toBe("workflow")
      expect(result.recallMode).toBe("contextual")
    })

    test("matches keywords in title", () => {
      const result = inferMigratedMemory("Debugging process", "Standard approach")
      expect(result.category).toBe("coding")
    })

    test("matches keywords in content", () => {
      const result = inferMigratedMemory("Process note", "Use commit messages consistently")
      expect(result.category).toBe("coding")
    })

    test("interaction takes priority over coding", () => {
      const result = inferMigratedMemory("Voice for coding", "How to respond during code review")
      expect(result.category).toBe("interaction")
    })

    test("gaming keyword maps to personal", () => {
      const result = inferMigratedMemory("Hobbies", "Enjoys gaming on weekends")
      expect(result.category).toBe("personal")
    })

    test("documentation keyword maps to writing", () => {
      const result = inferMigratedMemory("Documentation standards", "How to document features properly")
      expect(result.category).toBe("writing")
    })
  })

  describe("defaultRecallMode", () => {
    test("identity categories default to always", () => {
      expect(defaultRecallMode("user")).toBe("always")
      expect(defaultRecallMode("self")).toBe("always")
      expect(defaultRecallMode("relationship")).toBe("always")
      expect(defaultRecallMode("interaction")).toBe("always")
    })

    test("personal and general default to search_only", () => {
      expect(defaultRecallMode("personal")).toBe("search_only")
      expect(defaultRecallMode("general")).toBe("search_only")
    })

    test("other categories default to contextual", () => {
      expect(defaultRecallMode("coding")).toBe("contextual")
      expect(defaultRecallMode("writing")).toBe("contextual")
      expect(defaultRecallMode("workflow")).toBe("contextual")
      expect(defaultRecallMode("asset")).toBe("contextual")
      expect(defaultRecallMode("insight")).toBe("contextual")
      expect(defaultRecallMode("knowledge")).toBe("contextual")
    })
  })

  describe("migration 1: source model fields", () => {
    test("adds source_provider_id and source_model_id columns", async () => {
      const conn = LibraryDB.connection()
      expect(hasColumn(conn, "experience", "source_provider_id")).toBe(true)
      expect(hasColumn(conn, "experience", "source_model_id")).toBe(true)
    })

    test("migration is idempotent", async () => {
      const migration = migrations.find((m) => m.id.includes("source-model"))
      expect(migration).toBeDefined()

      const progressLog: [number, number][] = []
      await migration!.up((current, total) => progressLog.push([current, total]))

      expect(progressLog.length).toBeGreaterThan(0)
    })
  })

  describe("migration 2: memory recall mode", () => {
    test("adds recall_mode column to memory table", async () => {
      const conn = LibraryDB.connection()
      expect(hasColumn(conn, "memory", "recall_mode")).toBe(true)
    })
  })

  describe("migration 3: purge invalid experiences", () => {
    test("removes experiences with empty intents", async () => {
      const conn = LibraryDB.connection()

      LibraryDB.Experience.insert({
        id: "exp-vec-init",
        sessionID: "sess-1",
        scopeID: "scope-1",
        intent: "Initialize vec tables",
        intentEmbedding: { id: "init", vector: [0, 0, 0, 0, 0, 0, 0, 0], model: "test" },
        scriptEmbedding: undefined,
        content: {},
        metadata: {},
        retrievedExperienceIDs: [],
        createdAt: Date.now(),
      })

      conn
        .prepare(
          `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
           script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
           q_updated_at, q_history, retrieved_experience_ids, reward_status, created_at, updated_at)
          VALUES (?, ?, ?, '', NULL, NULL, NULL, NULL, NULL, '{}', '{}', 0, NULL, '[]', '[]', 'evaluated', ?, ?)`,
        )
        .run("exp-invalid-1", "sess-1", "scope-1", Date.now(), Date.now())

      conn
        .prepare(
          `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
           script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
           q_updated_at, q_history, retrieved_experience_ids, reward_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, '{}', '{}', 0, NULL, '[]', '[]', 'evaluated', ?, ?)`,
        )
        .run("exp-valid-1", "sess-1", "scope-1", "This is a valid intent description", Date.now(), Date.now())

      const migration = migrations.find((m) => m.id.includes("purge"))
      expect(migration).toBeDefined()

      await migration!.up(() => {})

      expect(LibraryDB.Experience.get("exp-invalid-1")).toBeNull()
      expect(LibraryDB.Experience.get("exp-valid-1")).not.toBeNull()
    })
  })

  describe("reencode job table migration", () => {
    test("creates the durable job schema idempotently", async () => {
      const migration = migrations.find((item) => item.id === "20260715-library-reencode-job-tables")
      expect(migration).toBeDefined()

      const progressLog: [number, number][] = []
      await migration!.up((current, total) => progressLog.push([current, total]))
      await migration!.up(() => {})

      const conn = LibraryDB.connection()
      expect(hasTable(conn, "experience_reencode_job")).toBe(true)
      expect(hasTable(conn, "experience_reencode_job_item")).toBe(true)
      expect(hasIndex(conn, "idx_experience_reencode_job_started")).toBe(true)
      expect(hasIndex(conn, "idx_experience_reencode_job_item_status")).toBe(true)
      expect(hasIndex(conn, "idx_experience_reencode_job_item_updated")).toBe(true)
      expect(progressLog.at(-1)).toEqual([1, 1])
    })
  })

  describe("experience user input migration", () => {
    test("adds the column and backfills only canonical rendered digests idempotently", async () => {
      const conn = LibraryDB.connection()
      const now = Date.now()
      conn.exec(`
        ALTER TABLE experience_content RENAME TO experience_content_current;
        CREATE TABLE experience_content (
          id         TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          scope_id   TEXT NOT NULL,
          script     TEXT,
          raw        TEXT,
          metadata   TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        DROP TABLE experience_content_current;
      `)
      conn
        .prepare(
          `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, ?4, '{}', ?5, ?5)`,
        )
        .run(
          "exp-user-input-migration",
          "sess-1",
          "scope-1",
          "### User\nRecover this exact request\n\n### Response\nThe request was completed.",
          now,
        )
      conn
        .prepare(
          `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, ?4, '{}', ?5, ?5)`,
        )
        .run(
          "exp-ambiguous-user-input",
          "sess-1",
          "scope-1",
          "### User\nKeep this literal:\n\n### Response\ninside my request\n\n### Response\nDone.",
          now,
        )
      const migration = migrations.find((item) => item.id === "20260724-library-experience-user-input")
      expect(migration).toBeDefined()
      expect(hasColumn(conn, "experience_content", "user_input")).toBe(false)

      await migration!.up(() => {})
      await migration!.up(() => {})

      const rows = conn.prepare("SELECT id, user_input FROM experience_content ORDER BY id").all() as {
        id: string
        user_input: string | null
      }[]
      expect(hasColumn(conn, "experience_content", "user_input")).toBe(true)
      expect(rows).toEqual([
        { id: "exp-ambiguous-user-input", user_input: null },
        { id: "exp-user-input-migration", user_input: "Recover this exact request" },
      ])
    })
  })

  describe("experience retrieval count migration", () => {
    test("adds the column and seeds previously-rewarded experiences from q_visits idempotently", async () => {
      const conn = LibraryDB.connection()

      // Drop the column to simulate a pre-migration database.
      conn.exec("ALTER TABLE experience RENAME TO experience_current")
      conn.exec(`
        CREATE TABLE experience (
          id                       TEXT PRIMARY KEY,
          session_id               TEXT NOT NULL,
          scope_id                 TEXT NOT NULL,
          intent                   TEXT NOT NULL,
          intent_embedding_model   TEXT,
          script_embedding_model   TEXT,
          source_provider_id       TEXT,
          source_model_id          TEXT,
          reward                   REAL,
          rewards                  TEXT NOT NULL DEFAULT '{}',
          q_values                 TEXT NOT NULL DEFAULT '{}',
          q_visits                 INTEGER NOT NULL DEFAULT 0,
          q_updated_at             INTEGER,
          q_history                TEXT NOT NULL DEFAULT '[]',
          retrieved_experience_ids TEXT NOT NULL DEFAULT '[]',
          reward_status            TEXT NOT NULL DEFAULT 'evaluated',
          turns_remaining          INTEGER,
          created_at               INTEGER NOT NULL,
          updated_at               INTEGER NOT NULL
        )
      `)
      conn.exec(
        `INSERT INTO experience (id, session_id, scope_id, intent, q_values, q_visits, created_at, updated_at)
         VALUES ('exp-rewarded', 's', 'sc', 'Handle the rewarded flow', '{}', 7, 1, 2),
                ('exp-unrewarded', 's', 'sc', 'Handle the unrewarded flow', '{}', 0, 1, 2)`,
      )
      conn.exec("DROP TABLE experience_current")

      const migration = migrations.find((item) => item.id === "20260824-library-experience-retrieval-count")
      expect(migration).toBeDefined()
      expect(hasColumn(conn, "experience", "retrieval_count")).toBe(false)

      await migration!.up(() => {})
      await migration!.up(() => {})

      expect(hasColumn(conn, "experience", "retrieval_count")).toBe(true)
      const rows = conn.prepare("SELECT id, retrieval_count FROM experience ORDER BY id").all() as {
        id: string
        retrieval_count: number
      }[]
      expect(rows).toEqual([
        { id: "exp-rewarded", retrieval_count: 7 },
        { id: "exp-unrewarded", retrieval_count: 0 },
      ])
    })
  })

  describe("legacy library upgrade without recall_mode column (issue 1081)", () => {
    test("opening a legacy database does not fail before the recall_mode migration runs", async () => {
      // CI shards run test files concurrently against the same library.db, so
      // the file may be fresh or reset by a sibling file. Bootstrap the full
      // schema first, then reshape memory into its pre-20260405 shape.
      LibraryDB.connection()
      closeDB()
      const raw = new Database(LibraryDB.dbPath())
      raw.exec("DROP TABLE IF EXISTS memory")
      raw.exec(`
        CREATE TABLE memory (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          content         TEXT NOT NULL,
          category        TEXT NOT NULL DEFAULT 'general',
          embedding_model TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        )
      `)
      raw.close()

      // Reopening must not throw: initialize() must tolerate the missing column
      // instead of failing while creating idx_memory_recall_mode.
      expect(() => LibraryDB.connection()).not.toThrow()
      const conn = LibraryDB.connection()
      expect(hasColumn(conn, "memory", "recall_mode")).toBe(false)
      expect(hasIndex(conn, "idx_memory_recall_mode")).toBe(false)

      // The recall_mode migration adds the column and its index.
      const migration = migrations.find((m) => m.id === "20260405-library-memory-recall-mode")
      expect(migration).toBeDefined()
      await migration!.up(() => {})

      expect(hasColumn(conn, "memory", "recall_mode")).toBe(true)
      expect(hasIndex(conn, "idx_memory_recall_mode")).toBe(true)
    })
  })
})
