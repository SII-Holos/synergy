import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const mockExperienceSearchResults = [
  {
    id: "exp_search_1",
    sessionID: "ses_search_1",
    scopeID: "scp_search_1",
    intent: "Search intent",
    sourceProviderID: "provider-a",
    sourceModelID: "model-a",
    reward: 0.75,
    rewards: { outcome: 0.8, confidence: 0.9, reason: "Strong match" },
    qValue: 0.62,
    qValues: { outcome: 0.7, intent: 0.5 },
    qVisits: 4,
    turnsRemaining: 1,
    similarity: 0.91,
    score: 1.23,
    script: "search script",
    raw: "search raw",
    createdAt: 1710000000000,
    updatedAt: 1710000001000,
  },
]

const mockMemorySearchResults = [
  {
    id: "mem_search_1",
    title: "Search memory",
    content: "Search memory content",
    category: "knowledge",
    recallMode: "contextual",
    similarity: 0.88,
    createdAt: 1710000000000,
    updatedAt: 1710000001000,
  },
]

mock.module("../../src/engram/experience-recall", () => ({
  ExperienceRecall: {
    retrieve: async () => mockExperienceSearchResults,
    trackRetrieval: () => {},
    consumeRetrieval: () => [],
    writeDebugLog: () => {},
    buildEvaluation: () => "",
  },
}))

mock.module("../../src/engram/memory-recall", () => ({
  MemoryRecall: {
    search: async () => mockMemorySearchResults,
  },
}))

type ServerModule = typeof import("../../src/server/server")
type InstanceModule = typeof import("../../src/scope/instance")
type DatabaseModule = typeof import("../../src/engram/database")

let Server: ServerModule["Server"]
let Instance: InstanceModule["Instance"]
let EngramDB: DatabaseModule["EngramDB"]
let closeDB: DatabaseModule["closeDB"]

beforeAll(async () => {
  ;({ Server } = await import("../../src/server/server"))
  ;({ Instance } = await import("../../src/scope/instance"))
  ;({ EngramDB, closeDB } = await import("../../src/engram/database"))
})

afterEach(async () => {
  EngramDB.Experience.removeAll()
  EngramDB.Memory.removeAll()
  await Instance.disposeAll()
  closeDB()
})

afterAll(async () => {
  await Instance.disposeAll()
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
  const conn = EngramDB.connection()
  conn
    .prepare(
      `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
       script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
       q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10, NULL, '[]', '[]', 'evaluated', ?11, ?12, ?13)`,
    )
    .run(
      input.id,
      input.sessionID,
      input.scopeID,
      input.intent,
      "provider-a",
      "model-a",
      input.reward,
      JSON.stringify(input.rewards),
      JSON.stringify(input.qValues),
      input.qVisits,
      input.turnsRemaining,
      input.createdAt,
      input.updatedAt,
    )

  conn
    .prepare(
      `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .run(
      input.id,
      input.sessionID,
      input.scopeID,
      input.script ?? null,
      input.raw ?? null,
      input.metadata ?? "{}",
      input.createdAt,
      input.updatedAt,
    )
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
  const conn = EngramDB.connection()
  conn
    .prepare(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)`,
    )
    .run(input.id, input.title, input.content, input.category, input.recallMode, input.createdAt, input.updatedAt)
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

describe("Engram API DTO contracts", () => {
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

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(
          `/engram/experience/page?filter=scope&scopeID=${scope.id}&sort=newest&limit=10&offset=0`,
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

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/engram/experience/exp_detail_1")
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

  test("experience search returns card fields plus search metadata without detail fields", async () => {
    await using project = await tmpdir({ git: true })
    const scope = await project.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/engram/experience/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "search query", topK: 5 }),
        })
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<Record<string, unknown>>
        expect(body).toHaveLength(1)
        expectExperienceCardFields(body[0])
        expect(body[0]).toEqual(
          expect.objectContaining({
            similarity: expect.any(Number),
            score: expect.any(Number),
          }),
        )
        expect(body[0]).not.toHaveProperty("script")
        expect(body[0]).not.toHaveProperty("raw")
        expect(body[0]).not.toHaveProperty("metadata")
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

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/engram")
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<Record<string, unknown>>
        expect(body).toHaveLength(1)
        expectMemoryCardFields(body[0])
      },
    })
  })

  test("memory search returns card fields plus similarity", async () => {
    await using project = await tmpdir({ git: true })
    const scope = await project.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/engram/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "memory query", topK: 5 }),
        })
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<Record<string, unknown>>
        expect(body).toHaveLength(1)
        expectMemoryCardFields(body[0])
        expect(body[0]).toEqual(
          expect.objectContaining({
            similarity: expect.any(Number),
          }),
        )
      },
    })
  })
})
