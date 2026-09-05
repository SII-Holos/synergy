import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { ScopeContext } from "../../src/scope/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { Config } from "../../src/config/config"
import { LibraryDB, closeDB } from "../../src/library/database"
import { ExperienceRecall } from "../../src/library/experience-recall"
import { ExperienceReencode } from "../../src/library/experience-reencode"
import { MemoryRecall } from "../../src/library/memory-recall"
import { Embedding } from "../../src/vector/embedding"
import { LibraryStatsEngine } from "../../src/library"

afterEach(async () => {
  LibraryDB.Experience.removeAll()
  LibraryDB.Memory.removeAll()
  LibraryDB.ReencodeJob.removeAll()
  await ScopeRuntime.disposeAll()
  closeDB()
  ;(ExperienceRecall.retrieve as any) = originalExperienceRecallRetrieve
  ;(MemoryRecall.search as any) = originalMemoryRecallSearch
  ;(Embedding.generate as any) = originalEmbeddingGenerate
  ;(Config.current as any) = originalConfigCurrent
  ;(LibraryStatsEngine.recompute as any) = originalStatsRecompute
})

afterAll(async () => {
  await ScopeRuntime.disposeAll()
  closeDB()
})

const originalExperienceRecallRetrieve = ExperienceRecall.retrieve
const originalMemoryRecallSearch = MemoryRecall.search
const originalEmbeddingGenerate = Embedding.generate
const originalConfigCurrent = Config.current
const originalStatsRecompute = LibraryStatsEngine.recompute

function insertExperience(input: {
  id: string
  sessionID: string
  scopeID: string
  intent: string
  reward: number | null
  rewards: Record<string, unknown>
  qValues: Record<string, number>
  qVisits: number
  turnsRemaining: number | null
  createdAt: number
  updatedAt: number
  rewardStatus?: string
  script?: string
  raw?: string
  metadata?: string
}) {
  const conn = LibraryDB.connection()
  conn
    .prepare(
      `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
       script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
       q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at)
       VALUES ($id, $sessionID, $scopeID, $intent, NULL, NULL, $providerID, $modelID, $reward, $rewards,
       $qValues, $qVisits, NULL, '[]', '[]', $rewardStatus, $turnsRemaining, $createdAt, $updatedAt)`,
    )
    .run({
      $id: input.id,
      $sessionID: input.sessionID,
      $scopeID: input.scopeID,
      $intent: input.intent,
      $providerID: "provider-a",
      $modelID: "model-a",
      $reward: input.reward,
      $rewards: JSON.stringify(input.rewards),
      $qValues: JSON.stringify(input.qValues),
      $qVisits: input.qVisits,
      $turnsRemaining: input.turnsRemaining,
      $rewardStatus: input.rewardStatus ?? "evaluated",
      $createdAt: input.createdAt,
      $updatedAt: input.updatedAt,
    })

  conn
    .prepare(
      `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
       VALUES ($id, $sessionID, $scopeID, $script, $raw, $metadata, $createdAt, $updatedAt)`,
    )
    .run({
      $id: input.id,
      $sessionID: input.sessionID,
      $scopeID: input.scopeID,
      $script: input.script ?? null,
      $raw: input.raw ?? null,
      $metadata: input.metadata ?? "{}",
      $createdAt: input.createdAt,
      $updatedAt: input.updatedAt,
    })
}

function insertMemory(input: {
  id: string
  title: string
  content: string
  category: string
  recallMode: string
  createdAt: number
  updatedAt: number
}) {
  const conn = LibraryDB.connection()
  conn
    .prepare(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at)
       VALUES ($id, $title, $content, $category, $recallMode, NULL, $createdAt, $updatedAt)`,
    )
    .run({
      $id: input.id,
      $title: input.title,
      $content: input.content,
      $category: input.category,
      $recallMode: input.recallMode,
      $createdAt: input.createdAt,
      $updatedAt: input.updatedAt,
    })
}

function expectExperienceCardFields(item: Record<string, unknown>) {
  expect(item).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      sessionID: expect.any(String),
      scopeID: expect.any(String),
      intent: expect.any(String),
      sourceProviderID: expect.anything(),
      sourceModelID: expect.anything(),
      reward: expect.anything(),
      rewards: expect.any(Object),
      qValue: expect.any(Number),
      qValues: expect.any(Object),
      qVisits: expect.any(Number),
      turnsRemaining: expect.anything(),
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }),
  )
}

function expectMemoryCardFields(item: Record<string, unknown>) {
  expect(item).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      title: expect.any(String),
      content: expect.any(String),
      category: expect.any(String),
      recallMode: expect.any(String),
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }),
  )
}

describe("Library API DTO contracts", () => {
  test("experience page returns stable card fields", async () => {
    await using project = await tmpdir({ git: true })
    const scope = await project.scope()

    insertExperience({
      id: "exp_page_1",
      sessionID: "ses_page_1",
      scopeID: scope.id,
      intent: "Ship feature",
      reward: 0.6,
      rewards: { outcome: 0.8, confidence: 0.9 },
      qValues: { outcome: 0.8, intent: 0.2 },
      qVisits: 3,
      turnsRemaining: 2,
      createdAt: 1710000000000,
      updatedAt: 1710000001000,
      script: "echo hi",
      raw: "raw body",
      metadata: '{"kind":"test"}',
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(
          `/library/experience/page?filter=scope&scopeID=${scope.id}&sort=newest&limit=10&offset=0`,
        )
        expect(response.status).toBe(200)

        const body = (await response.json()) as { items: Array<Record<string, unknown>> }
        expect(body.items).toHaveLength(1)
        expectExperienceCardFields(body.items[0])
      },
    })
  })

  test("experience detail extends card fields with detail-only fields", async () => {
    await using project = await tmpdir({ git: true })
    const scope = await project.scope()

    insertExperience({
      id: "exp_detail_1",
      sessionID: "ses_detail_1",
      scopeID: scope.id,
      intent: "Inspect detail",
      reward: 0.4,
      rewards: { outcome: 0.5, confidence: 0.8 },
      qValues: { outcome: 0.5, execution: 0.4 },
      qVisits: 7,
      turnsRemaining: 0,
      createdAt: 1710000002000,
      updatedAt: 1710000003000,
      script: "console.log('detail')",
      raw: "detail raw",
      metadata: '{"detail":true}',
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/library/experience/exp_detail_1")
        expect(response.status).toBe(200)

        const body = (await response.json()) as Record<string, unknown>
        expectExperienceCardFields(body)
        expect(body).toEqual(
          expect.objectContaining({
            script: "console.log('detail')",
            raw: "detail raw",
            metadata: '{"detail":true}',
          }),
        )
      },
    })
  })

  test("memory list returns stable card fields", async () => {
    await using project = await tmpdir({ git: true })
    const scope = await project.scope()

    insertMemory({
      id: "mem_list_1",
      title: "Memory title",
      content: "Memory content",
      category: "knowledge",
      recallMode: "contextual",
      createdAt: 1710000000000,
      updatedAt: 1710000001000,
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/library")
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<Record<string, unknown>>
        expect(body).toHaveLength(1)
        expectMemoryCardFields(body[0])
      },
    })
  })

  describe("Library API experience routes", () => {
    test("lists experiences with optional scope filter and validates page params", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_list_1",
        sessionID: "ses_list_1",
        scopeID: scope.id,
        intent: "Ship the list route",
        reward: 0.2,
        rewards: { outcome: 0.2 },
        qValues: { outcome: 0.2 },
        qVisits: 1,
        turnsRemaining: 1,
        createdAt: 1710000005000,
        updatedAt: 1710000006000,
      })
      LibraryDB.connection().prepare("UPDATE experience SET rewards = '{broken' WHERE id = 'exp_list_1'").run()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const all = await app.request("/library/experience")
          expect(all.status).toBe(200)
          const allBody = (await all.json()) as Array<Record<string, unknown>>
          expect(allBody.map((row) => row.id)).toContain("exp_list_1")

          const scoped = await app.request(`/library/experience?scopeID=${scope.id}`)
          expect(scoped.status).toBe(200)
          const scopedBody = (await scoped.json()) as Array<Record<string, unknown>>
          expect(scopedBody).toHaveLength(1)
          expectExperienceCardFields(scopedBody[0])

          const invalidPage = await app.request("/library/experience/page?filter=scope")
          expect(invalidPage.status).toBe(400)
          const invalidSessionPage = await app.request("/library/experience/page?filter=session")
          expect(invalidSessionPage.status).toBe(400)
        },
      })
    })

    test("searches experiences through the recall pipeline", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      ;(ExperienceRecall.retrieve as any) = mock(async () => [
        {
          id: "exp_search_1",
          sessionID: "ses_search_1",
          scopeID: scope.id,
          intent: "Ship the search route",
          sourceProviderID: "provider-a",
          sourceModelID: "model-a",
          reward: 0.5,
          rewards: { outcome: 0.5 },
          qValue: 0.5,
          qValues: { outcome: 0.5 },
          qVisits: 2,
          turnsRemaining: 1,
          createdAt: 1710000007000,
          updatedAt: 1710000008000,
          similarity: 0.91,
          score: 0.87,
        },
      ])

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const response = await Server.App().request("/library/experience/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "ship", scopeID: scope.id, topK: 3 }),
          })
          expect(response.status).toBe(200)

          const body = (await response.json()) as Array<Record<string, unknown>>
          expect(body).toHaveLength(1)
          expect(body[0]).toEqual(
            expect.objectContaining({
              id: "exp_search_1",
              similarity: 0.91,
              score: 0.87,
              qValue: 0.5,
            }),
          )
        },
      })
    })

    test("deletes an experience and reports missing rows", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_del_1",
        sessionID: "ses_del_1",
        scopeID: scope.id,
        intent: "Ship the delete route",
        reward: 0.1,
        rewards: { outcome: 0.1 },
        qValues: { outcome: 0.1 },
        qVisits: 1,
        turnsRemaining: null,
        createdAt: 1710000009000,
        updatedAt: 1710000010000,
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const missing = await app.request("/library/experience/exp_missing")
          expect(missing.status).toBe(404)
          expect(await missing.json()).toEqual({ message: "Experience not found: exp_missing" })

          const removed = await app.request("/library/experience/exp_del_1", { method: "DELETE" })
          expect(removed.status).toBe(200)
          expect(await removed.json()).toBe(true)

          const gone = await app.request("/library/experience/exp_del_1")
          expect(gone.status).toBe(404)
        },
      })
    })

    test("applies an external reward with the default learning weights", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_reward_1",
        sessionID: "ses_reward_1",
        scopeID: scope.id,
        intent: "Ship the reward route",
        reward: 0,
        rewards: {},
        qValues: {},
        qVisits: 0,
        turnsRemaining: 3,
        createdAt: 1710000011000,
        updatedAt: 1710000012000,
      })
      ;(Config.current as any) = mock(async () => ({}))

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const applied = await app.request("/library/experience/exp_reward_1/reward", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reward: 0.5 }),
          })
          expect(applied.status).toBe(200)
          const body = (await applied.json()) as { compositeReward: number; rewards: Record<string, number> }
          expect(body.compositeReward).toBeCloseTo(0.5 * Config.REWARD_WEIGHT_DEFAULTS.outcome)
          expect(body.rewards).toEqual({ outcome: 0.5 })

          const missing = await app.request("/library/experience/exp_missing/reward", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reward: 0.5 }),
          })
          expect(missing.status).toBe(404)
        },
      })
    })

    test("detects encoding issues and groups candidates", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_detect_failed",
        sessionID: "ses_detect_1",
        scopeID: scope.id,
        intent: "Fix the login redirect bug",
        reward: null,
        rewards: {},
        qValues: {},
        qVisits: 0,
        turnsRemaining: null,
        createdAt: 1710000013000,
        updatedAt: 1710000014000,
        rewardStatus: "encoding_failed",
        script: "echo hi",
      })
      insertExperience({
        id: "exp_detect_empty",
        sessionID: "ses_detect_2",
        scopeID: scope.id,
        intent: "",
        reward: null,
        rewards: {},
        qValues: {},
        qVisits: 0,
        turnsRemaining: null,
        createdAt: 1710000015000,
        updatedAt: 1710000016000,
        script: "echo bye",
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const response = await Server.App().request("/library/experience/detect", { method: "POST" })
          expect(response.status).toBe(200)

          const body = (await response.json()) as {
            scannedAt: number
            intent: {
              total: number
              groups: Array<{ reason: string; count: number; label: string; samples: Array<{ id: string }> }>
            }
          }
          expect(body.intent.total).toBe(2)
          expect(body.intent.groups.find((group) => group.reason === "empty")).toEqual(
            expect.objectContaining({
              count: 1,
              label: "Intent is empty",
              samples: [expect.objectContaining({ id: "exp_detect_empty" })],
            }),
          )
          expect(
            body.intent.groups.find((group) => group.samples.some((sample) => sample.id === "exp_detect_failed")),
          ).toBeDefined()
        },
      })
    })

    test("returns the stats summary and recomputes analytics on demand", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_stats_1",
        sessionID: "ses_stats_1",
        scopeID: scope.id,
        intent: "Ship the stats route",
        reward: 0.3,
        rewards: { outcome: 0.3 },
        qValues: { outcome: 0.3 },
        qVisits: 1,
        turnsRemaining: null,
        createdAt: 1710000017000,
        updatedAt: 1710000018000,
      })
      insertMemory({
        id: "mem_stats_1",
        title: "Stats memory",
        content: "Stats content",
        category: "knowledge",
        recallMode: "contextual",
        createdAt: 1710000019000,
        updatedAt: 1710000020000,
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const summary = await app.request("/library/stats")
          expect(summary.status).toBe(200)
          const summaryBody = (await summary.json()) as {
            memory: { count: number }
            experience: { count: number }
            dbSizeBytes: number
          }
          expect(summaryBody.memory.count).toBe(1)
          expect(summaryBody.experience.count).toBe(1)
          expect(summaryBody.dbSizeBytes).toBeGreaterThan(0)

          const recomputed = await app.request("/library/stats?recompute=true")
          expect(recomputed.status).toBe(200)
          ;(LibraryStatsEngine.recompute as any) = mock(async () => {
            throw new Error("stats offline")
          })
          const failedRecompute = await app.request("/library/stats?recompute=true")
          expect(failedRecompute.status).toBe(400)
        },
      })
    })
    test("streams reencode job progress over SSE and completes with the job", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const response = await Server.App().request("/library/experience/reencode", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "intent" }),
          })
          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toContain("text/event-stream")

          const text = await response.text()
          expect(text).toContain('"type":"start"')
          expect(text).toContain('"type":"done"')
          expect(text).toContain('"status":"completed"')
        },
      })
    })

    test("reports not-found and not-running states when cancelling", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const missing = await app.request("/library/experience/reencode/jobs/current/cancel", {
            method: "POST",
          })
          expect(missing.status).toBe(404)
          expect(await missing.json()).toEqual({ code: "REENCODE_JOB_NOT_FOUND", message: "No reencode job exists" })

          const started = await app.request("/library/experience/reencode/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "script" }),
          })
          expect(started.status).toBe(200)

          const notRunning = await app.request("/library/experience/reencode/jobs/current/cancel", {
            method: "POST",
          })
          expect(notRunning.status).toBe(409)
          expect(await notRunning.json()).toEqual(expect.objectContaining({ code: "REENCODE_JOB_NOT_RUNNING" }))
        },
      })
    })

    test("rejects a local download when the configured embedding mode flips to remote", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      const originalEmbeddingStatus = Embedding.status
      const originalEmbeddingWarmup = Embedding.warmup
      let statusCalls = 0
      ;(Embedding.status as any) = mock(async () => {
        statusCalls++
        return statusCalls === 1
          ? { mode: "local", model: "local-model", source: "huggingface", asset: "missing", progress: null }
          : { mode: "remote", model: "remote-model" }
      })
      ;(Embedding.warmup as any) = mock(async () => undefined)
      try {
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const response = await Server.App().request("/library/embedding/download", { method: "POST" })
            expect(response.status).toBe(409)
            expect(await response.json()).toEqual({
              code: "EMBEDDING_REMOTE_CONFIGURED",
              message: "Local embedding download is unavailable while a remote embedding service is configured",
            })
          },
        })
      } finally {
        ;(Embedding.status as any) = originalEmbeddingStatus
        ;(Embedding.warmup as any) = originalEmbeddingWarmup
      }
    })
  })

  describe("Library API memory routes", () => {
    test("searches memories semantically and reports failures", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      ;(MemoryRecall.search as any) = mock(async () => [
        {
          id: "mem_search_1",
          title: "Deploy runbook",
          content: "Ship behind the flag",
          category: "workflow",
          recallMode: "contextual",
          similarity: 0.88,
          createdAt: 1710000021000,
          updatedAt: 1710000022000,
        },
      ])

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const found = await app.request("/library/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "deploy", topK: 2 }),
          })
          expect(found.status).toBe(200)
          const foundBody = (await found.json()) as Array<Record<string, unknown>>
          expect(foundBody).toHaveLength(1)
          expect(foundBody[0]).toEqual(expect.objectContaining({ id: "mem_search_1", similarity: 0.88 }))
          ;(MemoryRecall.search as any) = mock(async () => {
            throw new Error("no embedding API")
          })
          const failed = await app.request("/library/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "deploy" }),
          })
          expect(failed.status).toBe(400)
          expect(((await failed.json()) as { message: string }).message).toContain("Search failed")
        },
      })
    })

    test("resets memory and experience data with scope filtering", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertExperience({
        id: "exp_reset_1",
        sessionID: "ses_reset_1",
        scopeID: scope.id,
        intent: "Ship the reset route",
        reward: 0.4,
        rewards: { outcome: 0.4 },
        qValues: { outcome: 0.4 },
        qVisits: 1,
        turnsRemaining: null,
        createdAt: 1710000023000,
        updatedAt: 1710000024000,
      })
      insertExperience({
        id: "exp_reset_other",
        sessionID: "ses_reset_2",
        scopeID: "scope_other",
        intent: "Keep me out of the scoped reset",
        reward: 0.4,
        rewards: { outcome: 0.4 },
        qValues: { outcome: 0.4 },
        qVisits: 1,
        turnsRemaining: null,
        createdAt: 1710000025000,
        updatedAt: 1710000026000,
      })
      insertMemory({
        id: "mem_reset_1",
        title: "Reset memory",
        content: "Reset content",
        category: "knowledge",
        recallMode: "contextual",
        createdAt: 1710000027000,
        updatedAt: 1710000028000,
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const scopedAll = await app.request("/library/reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "all", scopeID: scope.id, confirm: true }),
          })
          expect(scopedAll.status).toBe(200)
          expect(await scopedAll.json()).toEqual({ deleted: { memory: 1, experience: 1 } })

          const remaining = await app.request("/library/reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "experience", confirm: true }),
          })
          expect(remaining.status).toBe(200)
          expect(await remaining.json()).toEqual({ deleted: { memory: 0, experience: 1 } })
        },
      })
    })

    test("gets and deletes a memory by id", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertMemory({
        id: "mem_get_1",
        title: "Gettable memory",
        content: "Gettable content",
        category: "knowledge",
        recallMode: "contextual",
        createdAt: 1710000029000,
        updatedAt: 1710000030000,
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const found = await app.request("/library/mem_get_1")
          expect(found.status).toBe(200)
          expectMemoryCardFields(await found.json())

          const missing = await app.request("/library/mem_missing")
          expect(missing.status).toBe(404)
          expect(await missing.json()).toEqual({ message: "Memory not found: mem_missing" })

          const removed = await app.request("/library/mem_get_1", { method: "DELETE" })
          expect(removed.status).toBe(200)
          expect(await removed.json()).toBe(true)
        },
      })
    })
    test("reports memory update failures and serves filtered memory lists", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      insertMemory({
        id: "mem_update_1",
        title: "Update me",
        content: "Update content",
        category: "knowledge",
        recallMode: "contextual",
        createdAt: 1710000031000,
        updatedAt: 1710000032000,
      })
      ;(Embedding.generate as any) = mock(async () => {
        throw new Error("embedding offline")
      })

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()

          const failed = await app.request("/library/memory/update", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "mem_update_1",
              title: "Updated title",
              content: "Updated content",
              category: "workflow",
              recallMode: "search_only",
            }),
          })
          expect(failed.status).toBe(400)
          expect(((await failed.json()) as { message: string }).message).toContain("Memory update failed")

          const filtered = await app.request("/library?category=knowledge&recallMode=contextual")
          expect(filtered.status).toBe(200)
          const filteredBody = (await filtered.json()) as Array<Record<string, unknown>>
          expect(filteredBody).toHaveLength(1)
          expect(filteredBody[0]).toEqual(expect.objectContaining({ id: "mem_update_1" }))
        },
      })
    })
  })

  describe("Library reencode job API", () => {
    test("reports when no job exists", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const response = await Server.App().request("/library/experience/reencode/jobs/current")
          expect(response.status).toBe(404)
          expect(await response.json()).toEqual({ code: "REENCODE_JOB_NOT_FOUND", message: "No reencode job exists" })
        },
      })
    })

    test("starts and persists an empty job", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const response = await Server.App().request("/library/experience/reencode/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "intent" }),
          })
          expect(response.status).toBe(200)

          const started = (await response.json()) as Record<string, unknown>
          expect(started).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              type: "intent",
              status: "completed",
              totalCount: 0,
              completedCount: 0,
            }),
          )
          expect(started).not.toHaveProperty("items")

          const current = await Server.App().request("/library/experience/reencode/jobs/current")
          expect(current.status).toBe(200)
          expect(await current.json()).toEqual(started)
        },
      })
    })

    test("rejects duplicate starts and cancels the active job", async () => {
      await using project = await tmpdir({ git: true })
      const scope = await project.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const running = ExperienceReencode.createJob({
            type: "script",
            candidates: [
              {
                id: "exp-active",
                sessionID: "session-active",
                scopeID: scope.id,
                reason: "invalid",
                detail: "invalid script",
              },
            ],
          })

          const duplicate = await Server.App().request("/library/experience/reencode/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "intent" }),
          })
          expect(duplicate.status).toBe(409)
          const duplicateBody = (await duplicate.json()) as {
            job: Record<string, unknown>
          }
          expect(duplicateBody).toEqual(
            expect.objectContaining({
              code: "REENCODE_JOB_ALREADY_RUNNING",
              job: expect.objectContaining({ id: running.id, status: "running" }),
            }),
          )
          expect(duplicateBody.job).not.toHaveProperty("items")

          const cancelled = await Server.App().request("/library/experience/reencode/jobs/current/cancel", {
            method: "POST",
          })
          expect(cancelled.status).toBe(200)
          const cancelledBody = (await cancelled.json()) as Record<string, unknown>
          expect(cancelledBody).toEqual(
            expect.objectContaining({ id: running.id, status: "cancelled", completedAt: expect.any(Number) }),
          )
          expect(cancelledBody).not.toHaveProperty("items")
        },
      })
    })
  })
})
