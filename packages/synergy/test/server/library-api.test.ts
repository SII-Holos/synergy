import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { ScopeContext } from "../../src/scope/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { LibraryDB, closeDB } from "../../src/library/database"
import { ExperienceReencode } from "../../src/library/experience-reencode"

afterEach(async () => {
  LibraryDB.Experience.removeAll()
  LibraryDB.Memory.removeAll()
  LibraryDB.ReencodeJob.removeAll()
  await ScopeRuntime.disposeAll()
  closeDB()
})

afterAll(async () => {
  await ScopeRuntime.disposeAll()
  closeDB()
})

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
       $qValues, $qVisits, NULL, '[]', '[]', 'evaluated', $turnsRemaining, $createdAt, $updatedAt)`,
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
