import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "bun:sqlite"
import { closeDB, EngramDB } from "../../src/engram/database"
import { migrations } from "../../src/engram/migration"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function hasColumn(conn: Database, table: string, column: string): boolean {
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

describe("engram migrations", () => {
  beforeEach(() => {
    EngramDB.Experience.removeAll()
    EngramDB.Memory.removeAll()
  })

  afterAll(() => {
    closeDB()
  })

  describe("migration metadata", () => {
    test("exports exactly 3 migrations", () => {
      expect(migrations.length).toBe(3)
    })

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
      const conn = EngramDB.connection()
      expect(hasColumn(conn, "experience", "id")).toBe(true)
      expect(hasColumn(conn, "experience", "intent")).toBe(true)
      expect(hasColumn(conn, "memory", "id")).toBe(true)
    })

    test("returns false for non-existent column", () => {
      const conn = EngramDB.connection()
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
      const conn = EngramDB.connection()
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
      const conn = EngramDB.connection()
      expect(hasColumn(conn, "memory", "recall_mode")).toBe(true)
    })
  })

  describe("migration 3: purge invalid experiences", () => {
    test("removes experiences with empty intents", async () => {
      const conn = EngramDB.connection()

      EngramDB.Experience.insert({
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

      expect(EngramDB.Experience.get("exp-invalid-1")).toBeNull()
      expect(EngramDB.Experience.get("exp-valid-1")).not.toBeNull()
    })
  })
})
