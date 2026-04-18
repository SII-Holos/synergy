import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { EngramDB, closeDB } from "../../src/engram/database"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const DIMENSIONS = 8

function fakeVector(values?: number[]): number[] {
  const base = values ?? Array.from({ length: DIMENSIONS }, () => Math.random())
  return base.slice(0, DIMENSIONS)
}

function fakeEmbedding(values?: number[]) {
  return { id: "emb", vector: fakeVector(values), model: "test-model" }
}

function makeExperience(id: string, overrides: Partial<Parameters<typeof EngramDB.Experience.insert>[0]> = {}) {
  return EngramDB.Experience.insert({
    id,
    sessionID: "sess-1",
    scopeID: "scope-1",
    intent: `Test intent for ${id}`,
    intentEmbedding: fakeEmbedding(),
    scriptEmbedding: undefined,
    content: { script: "print('hello')", raw: "hello" },
    metadata: {},
    retrievedExperienceIDs: [],
    createdAt: Date.now(),
    ...overrides,
  })
}

function makeMemory(id: string, overrides: Partial<Parameters<typeof EngramDB.Memory.insert>[0]> = {}) {
  return EngramDB.Memory.insert(
    {
      id,
      title: `Memory ${id}`,
      content: `Content for ${id}`,
      category: "general",
      recallMode: "search_only",
      ...overrides,
    },
    fakeEmbedding(),
  )
}

describe("EngramDB", () => {
  beforeEach(() => {
    EngramDB.Experience.removeAll()
    EngramDB.Memory.removeAll()
  })

  afterAll(() => {
    closeDB()
  })

  describe("Experience", () => {
    test("insert and get", () => {
      makeExperience("exp-1")
      const row = EngramDB.Experience.get("exp-1")
      expect(row).not.toBeNull()
      expect(row!.id).toBe("exp-1")
      expect(row!.intent).toBe("Test intent for exp-1")
      expect(row!.session_id).toBe("sess-1")
      expect(row!.scope_id).toBe("scope-1")
      expect(row!.reward_status).toBe("pending")
    })

    test("get non-existent returns null", () => {
      expect(EngramDB.Experience.get("no-such-id")).toBeNull()
    })

    test("getContent returns content row", () => {
      makeExperience("exp-content")
      const content = EngramDB.Experience.getContent("exp-content")
      expect(content).not.toBeNull()
      expect(content!.script).toBe("print('hello')")
      expect(content!.raw).toBe("hello")
    })

    test("getContent for non-existent returns null", () => {
      expect(EngramDB.Experience.getContent("no-such-id")).toBeNull()
    })

    test("insert with upsert semantics", () => {
      makeExperience("exp-upsert", { intent: "Original intent" })
      const row1 = EngramDB.Experience.get("exp-upsert")
      expect(row1!.intent).toBe("Original intent")

      makeExperience("exp-upsert", { intent: "Updated intent" })
      const row2 = EngramDB.Experience.get("exp-upsert")
      expect(row2!.intent).toBe("Updated intent")
      expect(EngramDB.Experience.count()).toBe(1)
    })

    test("insertFailed creates record with encoding_failed status", () => {
      EngramDB.Experience.insertFailed({
        id: "exp-failed",
        sessionID: "sess-1",
        scopeID: "scope-1",
        createdAt: Date.now(),
        sourceProviderID: "prov-1",
        sourceModelID: "model-1",
      })
      const row = EngramDB.Experience.get("exp-failed")
      expect(row).not.toBeNull()
      expect(row!.reward_status).toBe("encoding_failed")
      expect(row!.source_provider_id).toBe("prov-1")
      expect(row!.source_model_id).toBe("model-1")
    })

    test("insertFailed with upsert semantics", () => {
      EngramDB.Experience.insertFailed({
        id: "exp-failed-upsert",
        sessionID: "sess-1",
        scopeID: "scope-1",
        createdAt: Date.now(),
        sourceProviderID: "prov-old",
      })
      EngramDB.Experience.insertFailed({
        id: "exp-failed-upsert",
        sessionID: "sess-1",
        scopeID: "scope-1",
        createdAt: Date.now(),
        sourceProviderID: "prov-new",
      })
      const row = EngramDB.Experience.get("exp-failed-upsert")
      expect(row!.source_provider_id).toBe("prov-new")
      expect(EngramDB.Experience.count()).toBe(1)
    })

    test("list returns experiences for a scope", () => {
      makeExperience("exp-a", { scopeID: "scope-a" })
      makeExperience("exp-b", { scopeID: "scope-a" })
      makeExperience("exp-c", { scopeID: "scope-b" })

      const list = EngramDB.Experience.list("scope-a")
      expect(list.length).toBe(2)
      expect(list.every((r) => r.scope_id === "scope-a")).toBe(true)
    })

    test("listAll returns all experiences", () => {
      makeExperience("exp-x", { scopeID: "scope-a" })
      makeExperience("exp-y", { scopeID: "scope-b" })

      const all = EngramDB.Experience.listAll()
      expect(all.length).toBe(2)
    })

    test("count returns total number", () => {
      makeExperience("exp-1")
      makeExperience("exp-2")
      expect(EngramDB.Experience.count()).toBe(2)
    })

    test("remove deletes experience and content", () => {
      makeExperience("exp-rm")
      expect(EngramDB.Experience.get("exp-rm")).not.toBeNull()
      expect(EngramDB.Experience.getContent("exp-rm")).not.toBeNull()

      EngramDB.Experience.remove("exp-rm")
      expect(EngramDB.Experience.get("exp-rm")).toBeNull()
      expect(EngramDB.Experience.getContent("exp-rm")).toBeNull()
    })

    test("removeAll deletes all experiences", () => {
      makeExperience("exp-1")
      makeExperience("exp-2")
      const deleted = EngramDB.Experience.removeAll()
      expect(deleted).toBe(2)
      expect(EngramDB.Experience.count()).toBe(0)
    })

    test("removeByScope deletes experiences for a scope", () => {
      makeExperience("exp-a1", { scopeID: "scope-a" })
      makeExperience("exp-a2", { scopeID: "scope-a" })
      makeExperience("exp-b1", { scopeID: "scope-b" })

      const deleted = EngramDB.Experience.removeByScope("scope-a")
      expect(deleted).toBe(2)
      expect(EngramDB.Experience.list("scope-a")).toHaveLength(0)
      expect(EngramDB.Experience.list("scope-b")).toHaveLength(1)
    })

    test("searchByIntent still works after close and reopen", () => {
      const vector = fakeVector([1, 0, 0, 0, 0, 0, 0, 0])
      makeExperience("exp-search", {
        intentEmbedding: { id: "emb-search", vector, model: "test-model" },
      })
      EngramDB.Experience.applyReward("exp-search", {
        rewards: { outcome: 1 },
        rewardWeights: {
          outcome: 0.35,
          intent: 0.25,
          execution: 0.2,
          orchestration: 0.1,
          expression: 0.1,
        },
        alpha: 0.3,
      })

      closeDB()

      const results = EngramDB.Experience.searchByIntent("scope-1", vector, 3)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.id).toBe("exp-search")
    })

    test("listPendingRewards returns pending experiences for a session", () => {
      makeExperience("exp-pend", { sessionID: "sess-pend" })
      EngramDB.Experience.insertFailed({
        id: "exp-fail",
        sessionID: "sess-pend",
        scopeID: "scope-1",
        createdAt: Date.now(),
      })

      const pending = EngramDB.Experience.listPendingRewards("sess-pend")
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe("exp-pend")
      expect(pending[0].reward_status).toBe("pending")
    })

    test("listFailed returns failed experiences for a session", () => {
      EngramDB.Experience.insertFailed({
        id: "exp-fail1",
        sessionID: "sess-fail",
        scopeID: "scope-1",
        createdAt: Date.now(),
      })
      makeExperience("exp-ok", { sessionID: "sess-fail" })

      const failed = EngramDB.Experience.listFailed("sess-fail")
      expect(failed).toHaveLength(1)
      expect(failed[0].id).toBe("exp-fail1")
    })

    test("updateTurnsRemaining", () => {
      makeExperience("exp-turns")
      EngramDB.Experience.updateTurnsRemaining("exp-turns", 5)
      const row = EngramDB.Experience.get("exp-turns")
      expect(row!.turns_remaining).toBe(5)
    })

    describe("applyReward", () => {
      const defaultWeights = {
        outcome: 0.35,
        intent: 0.25,
        execution: 0.2,
        orchestration: 0.1,
        expression: 0.1,
      }

      test("calculates composite reward from weighted dimensions", () => {
        makeExperience("exp-reward")
        const result = EngramDB.Experience.applyReward("exp-reward", {
          rewards: {
            outcome: 1,
            intent: 1,
            execution: 1,
            orchestration: 1,
            expression: 1,
          },
          rewardWeights: defaultWeights,
          alpha: 0.3,
        })

        expect(result).not.toBeNull()
        expect(result!.compositeReward).toBeCloseTo(1.0)
        const row = EngramDB.Experience.get("exp-reward")
        expect(row!.reward).toBeCloseTo(1.0)
        expect(row!.reward_status).toBe("evaluated")
      })

      test("composite reward is clamped to [-1, 1]", () => {
        makeExperience("exp-clamp")
        const result = EngramDB.Experience.applyReward("exp-clamp", {
          rewards: {
            outcome: -1,
            intent: -1,
            execution: -1,
            orchestration: -1,
            expression: -1,
          },
          rewardWeights: defaultWeights,
          alpha: 0.3,
        })
        expect(result!.compositeReward).toBe(-1)
      })

      test("returns null for non-existent experience", () => {
        const result = EngramDB.Experience.applyReward("no-such-id", {
          rewards: { outcome: 1 },
          rewardWeights: defaultWeights,
          alpha: 0.3,
        })
        expect(result).toBeNull()
      })

      test("propagates Q-value updates to retrieved experiences", () => {
        makeExperience("exp-src")
        makeExperience("exp-retrieved", { retrievedExperienceIDs: [] })
        const retrievedId = "exp-retrieved"

        makeExperience("exp-with-refs", {
          retrievedExperienceIDs: [retrievedId],
        })

        EngramDB.Experience.applyReward("exp-with-refs", {
          rewards: { outcome: 0.8 },
          rewardWeights: defaultWeights,
          alpha: 0.5,
        })

        const retrieved = EngramDB.Experience.get(retrievedId)
        expect(retrieved).not.toBeNull()
        expect(retrieved!.q_visits).toBe(1)
      })

      test("respects confidence modifier on alpha", () => {
        makeExperience("exp-ret-c", { retrievedExperienceIDs: [] })
        makeExperience("exp-conf", { retrievedExperienceIDs: ["exp-ret-c"] })

        EngramDB.Experience.applyReward("exp-conf", {
          rewards: { outcome: 1.0, confidence: 0.5 },
          rewardWeights: defaultWeights,
          alpha: 0.4,
        })

        const retrieved = EngramDB.Experience.get("exp-ret-c")
        const qValues = JSON.parse(retrieved!.q_values)
        const effectiveAlpha = 0.4 * 0.5
        expect(qValues.outcome).toBeCloseTo(effectiveAlpha * 1.0)
      })

      test("partial rewards only update provided dimensions", () => {
        makeExperience("exp-ret-p", { retrievedExperienceIDs: [] })
        makeExperience("exp-partial", { retrievedExperienceIDs: ["exp-ret-p"] })

        EngramDB.Experience.applyReward("exp-partial", {
          rewards: { outcome: 1.0 },
          rewardWeights: defaultWeights,
          alpha: 0.5,
        })

        const retrieved = EngramDB.Experience.get("exp-ret-p")
        const qValues = JSON.parse(retrieved!.q_values)
        expect(qValues.outcome).toBeCloseTo(0.5)
        expect(qValues.intent).toBe(0)
        expect(qValues.execution).toBe(0)
      })
    })

    describe("updateQValues", () => {
      test("blends Q-values using alpha", () => {
        makeExperience("exp-q1")

        const afterUpdate = EngramDB.Experience.updateQValues("exp-q1", 0.5, { outcome: 1.0, intent: 0.8 })
        expect(afterUpdate).not.toBeNull()

        const qValues = JSON.parse(afterUpdate!.q_values)
        expect(qValues.outcome).toBeCloseTo(0.5)
        expect(qValues.intent).toBeCloseTo(0.4)
      })

      test("increments visit count", () => {
        makeExperience("exp-q2")
        EngramDB.Experience.updateQValues("exp-q2", 0.5, { outcome: 1.0 })
        const row = EngramDB.Experience.updateQValues("exp-q2", 0.5, { outcome: 1.0 })
        expect(row!.q_visits).toBe(2)
      })

      test("returns null for non-existent experience", () => {
        expect(EngramDB.Experience.updateQValues("no-such-id", 0.5, { outcome: 1.0 })).toBeNull()
      })

      test("maintains Q-value history up to max size", () => {
        makeExperience("exp-q3")
        for (let i = 0; i < 5; i++) {
          EngramDB.Experience.updateQValues("exp-q3", 0.5, { outcome: i * 0.1 }, 3)
        }
        const row = EngramDB.Experience.get("exp-q3")
        const history = JSON.parse(row!.q_history)
        expect(history.length).toBeLessThanOrEqual(3)
      })
    })

    describe("page", () => {
      const defaultWeights = {
        outcome: 0.35,
        intent: 0.25,
        execution: 0.2,
        orchestration: 0.1,
        expression: 0.1,
      }

      function seedExperiences() {
        for (let i = 0; i < 5; i++) {
          makeExperience(`exp-page-${i}`, {
            scopeID: "scope-page",
            sessionID: "sess-page",
            createdAt: 1000 + i * 100,
          })
        }
        makeExperience("exp-page-other", {
          scopeID: "scope-other",
          sessionID: "sess-other",
          createdAt: 2000,
        })
      }

      test("returns paginated results", () => {
        seedExperiences()
        const result = EngramDB.Experience.page({
          filter: "all",
          sort: "newest",
          limit: 3,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        expect(result.items.length).toBe(3)
        expect(result.total).toBe(6)
        expect(result.hasMore).toBe(true)
      })

      test("hasMore is false at last page", () => {
        seedExperiences()
        const result = EngramDB.Experience.page({
          filter: "all",
          sort: "newest",
          limit: 3,
          offset: 3,
          rewardWeights: defaultWeights,
        })
        expect(result.hasMore).toBe(false)
      })

      test("filter by scope", () => {
        seedExperiences()
        const result = EngramDB.Experience.page({
          filter: "scope",
          scopeID: "scope-page",
          sort: "newest",
          limit: 10,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        expect(result.total).toBe(5)
      })

      test("filter by session", () => {
        seedExperiences()
        const result = EngramDB.Experience.page({
          filter: "session",
          sessionID: "sess-other",
          sort: "newest",
          limit: 10,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        expect(result.total).toBe(1)
      })

      test("sort by oldest", () => {
        seedExperiences()
        const result = EngramDB.Experience.page({
          filter: "scope",
          scopeID: "scope-page",
          sort: "oldest",
          limit: 10,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        expect(result.items[0].id).toBe("exp-page-0")
        expect(result.items[result.items.length - 1].id).toBe("exp-page-4")
      })

      test("sort by visits", () => {
        seedExperiences()
        EngramDB.Experience.updateQValues("exp-page-3", 0.5, { outcome: 1 })
        EngramDB.Experience.updateQValues("exp-page-3", 0.5, { outcome: 1 })
        EngramDB.Experience.updateQValues("exp-page-1", 0.5, { outcome: 1 })

        const result = EngramDB.Experience.page({
          filter: "scope",
          scopeID: "scope-page",
          sort: "visits",
          limit: 10,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        expect(result.items[0].id).toBe("exp-page-3")
      })

      test("sort by reward", () => {
        seedExperiences()
        EngramDB.Experience.applyReward("exp-page-2", {
          rewards: { outcome: 0.9 },
          rewardWeights: defaultWeights,
          alpha: 0.3,
        })
        EngramDB.Experience.applyReward("exp-page-0", {
          rewards: { outcome: 0.1 },
          rewardWeights: defaultWeights,
          alpha: 0.3,
        })

        const result = EngramDB.Experience.page({
          filter: "scope",
          scopeID: "scope-page",
          sort: "reward",
          limit: 10,
          offset: 0,
          rewardWeights: defaultWeights,
        })
        const rewarded = result.items.filter((i) => i.reward !== null)
        expect(rewarded[0].id).toBe("exp-page-2")
      })
    })
  })

  describe("Memory", () => {
    test("insert and get", () => {
      makeMemory("mem-1", {
        title: "Test Memory",
        content: "Some content",
        category: "coding",
        recallMode: "contextual",
      })
      const row = EngramDB.Memory.get("mem-1")
      expect(row).not.toBeNull()
      expect(row!.title).toBe("Test Memory")
      expect(row!.content).toBe("Some content")
      expect(row!.category).toBe("coding")
      expect(row!.recall_mode).toBe("contextual")
    })

    test("get non-existent returns null", () => {
      expect(EngramDB.Memory.get("no-such-id")).toBeNull()
    })

    test("getMany returns multiple memories", () => {
      makeMemory("mem-a")
      makeMemory("mem-b")
      makeMemory("mem-c")

      const rows = EngramDB.Memory.getMany(["mem-a", "mem-c"])
      expect(rows.length).toBe(2)
    })

    test("getMany with empty array returns empty", () => {
      expect(EngramDB.Memory.getMany([])).toHaveLength(0)
    })

    test("list returns all memories", () => {
      makeMemory("mem-1")
      makeMemory("mem-2")
      const rows = EngramDB.Memory.listAll()
      expect(rows.length).toBe(2)
    })

    test("listByCategories filters by category", () => {
      makeMemory("mem-coding", { category: "coding" })
      makeMemory("mem-personal", { category: "personal" })
      makeMemory("mem-coding2", { category: "coding" })

      const coding = EngramDB.Memory.listByCategories(["coding"])
      expect(coding.length).toBe(2)
      expect(coding.every((r) => r.category === "coding")).toBe(true)
    })

    test("list with recall mode filter", () => {
      makeMemory("mem-always", { category: "user", recallMode: "always" })
      makeMemory("mem-search", { category: "general", recallMode: "search_only" })

      const always = EngramDB.Memory.list({ recallModes: ["always"] })
      expect(always.every((r) => r.recall_mode === "always")).toBe(true)
    })

    test("update modifies an existing memory", () => {
      makeMemory("mem-upd", { title: "Old title", content: "Old content" })
      const updated = EngramDB.Memory.update(
        { id: "mem-upd", title: "New title", content: "New content", category: "coding", recallMode: "contextual" },
        fakeEmbedding(),
      )
      expect(updated).not.toBeNull()
      expect(updated!.title).toBe("New title")
      expect(updated!.content).toBe("New content")
      expect(updated!.category).toBe("coding")
    })

    test("update returns null for non-existent memory", () => {
      const result = EngramDB.Memory.update(
        { id: "no-such-id", title: "X", content: "Y", category: "general", recallMode: "search_only" },
        fakeEmbedding(),
      )
      expect(result).toBeNull()
    })

    test("remove deletes a memory", () => {
      makeMemory("mem-rm")
      expect(EngramDB.Memory.get("mem-rm")).not.toBeNull()
      EngramDB.Memory.remove("mem-rm")
      expect(EngramDB.Memory.get("mem-rm")).toBeNull()
    })

    test("removeAll deletes all memories", () => {
      makeMemory("mem-1")
      makeMemory("mem-2")
      const deleted = EngramDB.Memory.removeAll()
      expect(deleted).toBe(2)
      expect(EngramDB.Memory.count()).toBe(0)
    })

    test("count returns total number", () => {
      makeMemory("mem-1")
      expect(EngramDB.Memory.count()).toBe(1)
    })

    test("searchByVector still works after close and reopen", () => {
      const vector = fakeVector([0, 1, 0, 0, 0, 0, 0, 0])
      EngramDB.Memory.insert(
        {
          id: "mem-search",
          title: "Search memory",
          content: "Search content",
          category: "general",
          recallMode: "search_only",
        },
        { id: "emb-memory", vector, model: "test-model" },
      )

      closeDB()

      const results = EngramDB.Memory.searchByVector(vector, 3)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.id).toBe("mem-search")
    })

    test("CATEGORIES includes all expected categories", () => {
      expect(EngramDB.Memory.CATEGORIES).toContain("user")
      expect(EngramDB.Memory.CATEGORIES).toContain("self")
      expect(EngramDB.Memory.CATEGORIES).toContain("relationship")
      expect(EngramDB.Memory.CATEGORIES).toContain("interaction")
      expect(EngramDB.Memory.CATEGORIES).toContain("workflow")
      expect(EngramDB.Memory.CATEGORIES).toContain("coding")
      expect(EngramDB.Memory.CATEGORIES).toContain("writing")
      expect(EngramDB.Memory.CATEGORIES).toContain("asset")
      expect(EngramDB.Memory.CATEGORIES).toContain("insight")
      expect(EngramDB.Memory.CATEGORIES).toContain("knowledge")
      expect(EngramDB.Memory.CATEGORIES).toContain("personal")
      expect(EngramDB.Memory.CATEGORIES).toContain("general")
    })

    test("RECALL_MODES includes all expected modes", () => {
      expect(EngramDB.Memory.RECALL_MODES).toEqual(["always", "contextual", "search_only"])
    })

    test("IDENTITY_CATEGORIES is a subset of CATEGORIES", () => {
      for (const cat of EngramDB.Memory.IDENTITY_CATEGORIES) {
        expect(EngramDB.Memory.CATEGORIES).toContain(cat)
      }
    })

    test("KNOWLEDGE_CATEGORIES is a subset of CATEGORIES", () => {
      for (const cat of EngramDB.Memory.KNOWLEDGE_CATEGORIES) {
        expect(EngramDB.Memory.CATEGORIES).toContain(cat)
      }
    })
  })

  describe("connection", () => {
    test("returns a database connection", () => {
      const conn = EngramDB.connection()
      expect(conn).toBeInstanceOf(Database)
    })

    test("dbPath is under the synergy data directory", () => {
      const dbPath = EngramDB.dbPath()
      expect(dbPath).toContain(".synergy")
      expect(dbPath).toContain("engram.db")
    })
  })
})
