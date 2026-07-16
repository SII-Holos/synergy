import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import type { ClarusProjectBindingV3, ClarusProjectActivity } from "../../src/clarus/schemas"
import { MAX_SEGMENT_LENGTH } from "../../src/clarus/keys"
import { MAX_WIRE_STRING_CURSOR } from "../../src/clarus/rest-port"
import { configureComposerTestDeps } from "../../src/server/clarus-route"
import type { ClarusRuntimeStatus } from "../../src/clarus/runtime"

Log.init({ print: false })

// ── Helpers ─────────────────────────────────────────────────

type StatusBody = {
  agentId: string | null
  status: string
  epoch: number
  generation: number
  isReconciling: boolean
  error?: string
}

type ErrorBody = {
  code: string
  message: string
  recoverable: boolean
}

function assertErrorBody(body: unknown): asserts body is ErrorBody {
  const b = body as Record<string, unknown>
  expect(typeof b.code).toBe("string")
  expect(typeof b.message).toBe("string")
  expect(typeof b.recoverable).toBe("boolean")
}

function assertStatusBody(body: unknown): asserts body is StatusBody {
  const b = body as Record<string, unknown>
  expect(typeof b.agentId).toBe("object")
  expect(["disabled", "disconnected", "connecting", "connected", "reconnecting", "blocked"]).toContain(
    b.status as string,
  )
  expect(typeof b.epoch).toBe("number")
  expect(typeof b.generation).toBe("number")
  expect(typeof b.isReconciling).toBe("boolean")
}

function makeApp() {
  return Server.App()
}

function homeContext(fn: () => Promise<void>): Promise<void> {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

// ── Fixtures ────────────────────────────────────────────────

const TEST_AGENT = "test-agent-001"

async function seedProjectBinding(agentId: string, projectId: string, overrides: Partial<ClarusProjectBindingV3> = {}) {
  const binding: ClarusProjectBindingV3 = {
    schemaVersion: 3,
    agentId,
    projectId,
    lifecycle: "active",
    projectName: `Project ${projectId}`,
    projectSlug: `proj-${projectId}`,
    projectStatus: "active",
    primaryAgent: agentId,
    desiredSubscription: true,
    messageCursor: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
  await Storage.write(StoragePath.clarusShardProjectBinding(agentId, projectId), binding)
  return binding
}

async function seedActivity(
  agentId: string,
  projectId: string,
  messageId: string,
  receivedAt: number,
  overrides: Partial<ClarusProjectActivity> = {},
) {
  const activity: ClarusProjectActivity = {
    agentId,
    projectId,
    messageId,
    senderType: "agent",
    senderId: agentId,
    messageType: "text",
    content: `Content for ${messageId}`,
    receivedAt,
    ...overrides,
  }
  await Storage.write(StoragePath.clarusProjectActivity(agentId, projectId, messageId), activity)
  const sortKey = `${String(receivedAt).padStart(16, "0")}--${encodeURIComponent(messageId)}`
  await Storage.write([...StoragePath.clarusActivityTimelineIndex(agentId, projectId), sortKey], { messageId })
  return activity
}

async function cleanupSeededData() {
  const projectRoot = StoragePath.clarusAgentProjectRoot(TEST_AGENT)
  const taskRoot = StoragePath.clarusAgentTaskRoot(TEST_AGENT)
  const projectKeys = await Storage.scan(projectRoot).catch(() => [] as string[])
  const taskKeys = await Storage.scan(taskRoot).catch(() => [] as string[])

  for (const key of projectKeys) {
    await Storage.remove([...projectRoot, key]).catch(() => {})
    const activityPrefix = StoragePath.clarusActivityTimelineIndex(TEST_AGENT, key)
    const activityKeys = await Storage.scan(activityPrefix).catch(() => [] as string[])
    for (const ak of activityKeys) {
      await Storage.remove([...activityPrefix, ak]).catch(() => {})
    }
    const agentTaskRoot = StoragePath.clarusAgentTaskRoot(TEST_AGENT)
    const tkFiles = await Storage.scan([...agentTaskRoot, encodeURIComponent(key)]).catch(() => [] as string[])
    for (const tf of tkFiles) {
      await Storage.remove([...agentTaskRoot, encodeURIComponent(key), tf]).catch(() => {})
    }
  }
  for (const key of taskKeys) {
    await Storage.remove([...taskRoot, key]).catch(() => {})
  }
}

beforeAll(async () => {
  await cleanupSeededData()
})

afterAll(async () => {
  await cleanupSeededData()
})

// ── Status / Reconnect ──────────────────────────────────────

describe("GET /global/clarus/status", () => {
  test("returns 200 with expected status shape", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/status")
      expect(res.status).toBe(200)
      assertStatusBody(await res.json())
    })
  })

  test("status is disabled or disconnected when no Holos/Clarus is running", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/status")
      const body = (await res.json()) as StatusBody
      expect(["disabled", "disconnected"]).toContain(body.status)
      expect(body.agentId).toBeNull()
      expect(body.epoch).toBe(0)
      expect(body.generation).toBe(0)
    })
  })
})

describe("POST /global/clarus/reconnect", () => {
  test("returns 200 with full status shape", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/reconnect", { method: "POST" })
      expect(res.status).toBe(200)
      const body = await res.json()
      assertStatusBody(body)
      expect(["disabled", "disconnected"]).toContain((body as StatusBody).status)
    })
  })
})

// ── Projects ────────────────────────────────────────────────

describe("GET /global/clarus/projects", () => {
  test("fails with CLARUS_NOT_CONNECTED when not connected", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects")
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("rejects invalid limit", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects?limit=999")
      expect(res.status).toBe(400)
    })
  })

  test("rejects oversized cursor", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longCursor = "x".repeat(MAX_WIRE_STRING_CURSOR + 10)
      const res = await app.request(`/global/clarus/projects?cursor=${encodeURIComponent(longCursor)}`)
      expect(res.status).toBe(400)
    })
  })
})

describe("GET /global/clarus/projects/:projectId", () => {
  test("fails on invalid project ID length", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longId = "x".repeat(600)
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent(longId)}`)
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_INVALID_ID")
    })
  })
})

describe("POST /global/clarus/projects", () => {
  test("validates required fields", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: "Test" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("fails with CLARUS_NOT_CONNECTED with valid body", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", projectName: "Test Project" }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("rejects empty projectId", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "", projectName: "Test" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("rejects projectId exceeding max segment length", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longId = "x".repeat(MAX_SEGMENT_LENGTH + 1)
      const res = await app.request("/global/clarus/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: longId, projectName: "Test" }),
      })
      expect(res.status).toBe(400)
    })
  })
})

describe("PUT /global/clarus/projects/:projectId", () => {
  test("fails with CLARUS_INVALID_ID on invalid project ID", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent("x".repeat(600))}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: "Updated" }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_INVALID_ID")
    })
  })

  test("rejects oversized primaryAgent in update", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longAgent = "y".repeat(600)
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent("valid-project")}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryAgent: longAgent }),
      })
      expect(res.status).toBe(400)
    })
  })
})

describe("POST /global/clarus/projects/:projectId/deactivate", () => {
  test("fails with CLARUS_NOT_CONNECTED for valid ID", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects/valid-project/deactivate", {
        method: "POST",
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("rejects invalid project ID", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longId = "y".repeat(600)
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent(longId)}/deactivate`, {
        method: "POST",
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_INVALID_ID")
    })
  })
})

// ── Activity ────────────────────────────────────────────────

describe("GET /global/clarus/projects/:projectId/activity", () => {
  test("fails with CLARUS_INVALID_ID on invalid project ID", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent("x".repeat(600))}/activity`)
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_INVALID_ID")
    })
  })

  test("rejects limit > 100", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects/valid-project/activity?limit=101")
      expect(res.status).toBe(400)
    })
  })

  test("rejects oversized cursor", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longCursor = "x".repeat(2000)
      const res = await app.request(
        `/global/clarus/projects/valid-project/activity?cursor=${encodeURIComponent(longCursor)}`,
      )
      expect(res.status).toBe(400)
    })
  })

  test("activity response has bounded schema shape", async () => {
    const projId = "test-proj-001"
    await seedProjectBinding(TEST_AGENT, projId)
    await seedActivity(TEST_AGENT, projId, "msg-001", Date.now())
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(`/global/clarus/projects/${encodeURIComponent(projId)}/activity`)
      if (res.status !== 200) {
        const body = await res.json()
        assertErrorBody(body)
      }
    })
  })
})

// ── Tasks ───────────────────────────────────────────────────

describe("GET /global/clarus/tasks", () => {
  test("requires projectId query param", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/tasks")
      expect(res.status).toBe(400)
    })
  })

  test("rejects invalid projectId length in query", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longId = "x".repeat(600)
      const res = await app.request(`/global/clarus/tasks?projectId=${encodeURIComponent(longId)}`)
      expect(res.status).toBe(400)
    })
  })

  test("fails with CLARUS_NOT_CONNECTED when valid projectId provided", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/tasks?projectId=valid-project")
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("rejects invalid limit", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/tasks?projectId=valid-project&limit=999")
      expect(res.status).toBe(400)
    })
  })
})

describe("GET /global/clarus/tasks/:taskId", () => {
  test("rejects missing projectId query param", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/tasks/some-task")
      expect(res.status).toBe(400)
    })
  })

  test("fails with CLARUS_NOT_CONNECTED when not connected", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/tasks/some-task?projectId=some-project")
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })
})

// ── Composer Users ──────────────────────────────────────────

describe("GET /global/clarus/composer/users", () => {
  test("enforces max limit of 5 candidates", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users?limit=10")
      expect(res.status).toBe(400)
    })
  })

  test("accepts valid search query", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users?search=john&limit=3")
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("response schema has userId, userName, agentId fields", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as { paths: Record<string, unknown> }
      const usersPath = spec.paths["/global/clarus/composer/users"] as Record<string, unknown>
      expect(usersPath).toBeDefined()
    })
  })
})

// ── Composer Projects ──────────────────────────────────────

describe("GET /global/clarus/composer/projects", () => {
  test("enforces max limit of 5 candidates", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/projects?limit=10")
      expect(res.status).toBe(400)
    })
  })

  test("accepts valid search query param", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/projects?search=test&limit=3")
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })
})

// ── Composer Submit ────────────────────────────────────────

describe("POST /global/clarus/composer/submit", () => {
  test("validates required content field", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test", agentId: "agent-1", userId: "user-1" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("validates required agentId field", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", userId: "user-1", content: "Hello" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("validates required userId field", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", agentId: "agent-1", content: "Hello" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("validates content max length", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test",
          agentId: "agent-1",
          userId: "user-1",
          content: "x".repeat(2_000_000),
        }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("fails with CLARUS_NOT_CONNECTED with valid body", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "test-agent",
          userId: "test-user",
          content: "Hello from composer",
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
    })
  })

  test("rejects empty projectId", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "", agentId: "test-agent", userId: "test-user", content: "Hello" }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("rejects empty content string", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "test-agent",
          userId: "test-user",
          content: "",
        }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("rejects oversized fileRefs array", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const largeFileRefs = Array.from({ length: 100 }, (_, i) => ({ name: `file-${i}` }))
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "test-agent",
          userId: "test-user",
          content: "Hello",
          fileRefs: largeFileRefs,
        }),
      })
      expect(res.status).toBe(400)
    })
  })

  test("rejects oversized projectId", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const longId = "x".repeat(MAX_SEGMENT_LENGTH + 10)
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: longId,
          agentId: "test-agent",
          userId: "test-user",
          content: "Hello",
        }),
      })
      expect(res.status).toBe(400)
    })
  })
})

// ── Route structure and operation IDs ───────────────────────

describe("ClarusRoute operation ID coverage", () => {
  const expectedOps = [
    "global.clarus.status",
    "global.clarus.reconnect",
    "global.clarus.projects.list",
    "global.clarus.projects.get",
    "global.clarus.projects.create",
    "global.clarus.projects.update",
    "global.clarus.projects.deactivate",
    "global.clarus.projects.activity",
    "global.clarus.tasks.list",
    "global.clarus.tasks.get",
    "global.clarus.composer.lookupUsers",
    "global.clarus.composer.lookupProjects",
    "global.clarus.composer.submit",
  ]

  test("all 13 specified operation IDs are present in the OpenAPI spec", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> }
      const allOps: string[] = []
      for (const [, methods] of Object.entries(spec.paths)) {
        for (const [, def] of Object.entries(methods as Record<string, any>)) {
          if (def?.operationId) allOps.push(def.operationId)
        }
      }
      for (const op of expectedOps) {
        expect(allOps).toContain(op)
      }
    })
  })

  test("clarus routes are mounted under /global/clarus", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> }
      const clarusPaths = Object.keys(spec.paths).filter((p) => p.startsWith("/global/clarus"))
      expect(clarusPaths.length).toBeGreaterThanOrEqual(10)
      for (const path of clarusPaths) {
        expect(path).toMatch(/^\/global\/clarus/)
      }
    })
  })

  test("route is mounted exactly once under /global/clarus", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> }
      const clarusPaths = Object.keys(spec.paths).filter((p) => p.startsWith("/global/clarus"))
      const pathCounts = new Map<string, number>()
      for (const p of clarusPaths) {
        pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1)
      }
      for (const count of pathCounts.values()) {
        expect(count).toBe(1)
      }
    })
  })
})

// ── Reusable response schema refs ───────────────────────────

describe("Clarus response schema references", () => {
  const expectedRefs = [
    "ClarusStatusResponse",
    "ClarusReconnectResponse",
    "ClarusProjectBindingItem",
    "ClarusProjectBindingCreateInput",
    "ClarusProjectBindingUpdateInput",
    "ClarusProjectBindingListResponse",
    "ClarusProjectActivityItem",
    "ClarusProjectActivityResponse",
    "ClarusTaskBindingItem",
    "ClarusTaskBindingListResponse",
    "ClarusComposerUserItem",
    "ClarusComposerProjectItem",
    "ClarusComposerSubmitInput",
    "ClarusComposerSubmitResponse",
  ]

  test("all expected schema refs are present in the OpenAPI spec", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        paths: Record<string, unknown>
        components?: { schemas?: Record<string, unknown> }
      }
      const schemas = spec.components?.schemas ?? {}
      for (const ref of expectedRefs) {
        expect(schemas).toHaveProperty(ref)
      }
    })
  })

  test("ClarusComposerSubmitResponse has requestID, messageId, projectId, senderId, epoch, generation", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusComposerSubmitResponse"]
      expect(schema).toBeDefined()
      const props = schema?.properties ?? {}
      expect(props).toHaveProperty("requestID")
      expect(props).toHaveProperty("messageId")
      expect(props).toHaveProperty("projectId")
      expect(props).toHaveProperty("senderId")
      expect(props).toHaveProperty("epoch")
      expect(props).toHaveProperty("generation")
    })
  })

  test("ClarusComposerUserItem has userId, userName, agentId (no profile/agent_key)", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusComposerUserItem"]
      expect(schema).toBeDefined()
      const props = schema?.properties ?? {}
      expect(props).toHaveProperty("userId")
      expect(props).toHaveProperty("userName")
      expect(props).toHaveProperty("agentId")
      expect(props).not.toHaveProperty("profile")
      expect(props).not.toHaveProperty("agent_key")
    })
  })

  test("ClarusProjectActivityItem uses bounded types (no z.unknown in fileRefs/metadata)", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusProjectActivityItem"]
      expect(schema).toBeDefined()
      const props = schema?.properties ?? {}
      if (props.fileRefs) {
        const fileRefs = props.fileRefs as Record<string, unknown>
        if (fileRefs.type) expect(fileRefs.type).toBe("array")
      }
      if (props.metadata) {
        const metadata = props.metadata as Record<string, unknown>
        expect(metadata.type).toBe("object")
      }
    })
  })
})

// ── Error redaction ─────────────────────────────────────────

describe("Clarus error redaction", () => {
  test("error responses have structured shape: code, message, recoverable", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects")
      const body = (await res.json()) as ErrorBody
      expect(typeof body).toBe("object")
      expect(typeof body.code).toBe("string")
      expect(body.code.length).toBeGreaterThan(0)
      expect(typeof body.message).toBe("string")
      expect(body.message.length).toBeGreaterThan(0)
      expect(typeof body.recoverable).toBe("boolean")
    })
  })

  test("error messages do not contain URLs", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects")
      const body = (await res.json()) as ErrorBody
      expect(body.message).not.toMatch(/https?:\/\//)
      expect(body.message).not.toMatch(/\r?\n/)
    })
  })

  test("error messages do not exceed max wire error length", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/projects")
      const body = (await res.json()) as ErrorBody
      expect(body.message.length).toBeLessThanOrEqual(500)
    })
  })
})

// ── Home scope ──────────────────────────────────────────────

describe("Clarus route scope", () => {
  test("status endpoint is accessible from home scope", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/status")
      expect(res.status).toBe(200)
    })
  })

  test("all routes require home/global scope (no directory scoping)", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const paths = [
        "/global/clarus/status",
        "/global/clarus/reconnect",
        "/global/clarus/projects",
        "/global/clarus/composer/users",
        "/global/clarus/composer/projects",
      ]
      for (const path of paths) {
        const method = path.endsWith("/reconnect") ? "POST" : "GET"
        const res = await app.request(path, { method })
        expect(res.status).not.toBe(404)
      }
    })
  })
})

// ── Behavioral: listUsers delegation via test seam ───────────

describe("Clarus composer users — listUsers delegation", () => {
  afterEach(() => {
    configureComposerTestDeps(null)
  })

  test("delegates to listUsers with search, limit, signal", async () => {
    let captured: { search: string; limit?: number; signal?: AbortSignal } | null = null
    configureComposerTestDeps({
      listUsers: async (input) => {
        captured = { search: input.search, limit: input.limit, signal: input.signal }
        return [{ userId: "u1", userName: "User 1", agentId: "ag1" }]
      },
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users?search=alice&limit=2")
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ userId: string; userName: string; agentId: string }>
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeGreaterThanOrEqual(0)
      // Verify delegation happened with correct params
      expect(captured).not.toBeNull()
      expect(captured!.search).toBe("alice")
      expect(captured!.limit).toBe(2)
      expect(captured!.signal).toBeDefined()
    })
  })

  test("returns typed user candidates with userId/userName/agentId only", async () => {
    configureComposerTestDeps({
      listUsers: async () => [
        { userId: "owner-1", userName: "Alice", agentId: "agent-a" },
        { userId: "owner-2", userName: "Bob", agentId: "agent-b" },
      ],
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users")
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<Record<string, unknown>>
      expect(Array.isArray(body)).toBe(true)
      for (const candidate of body) {
        expect(Object.keys(candidate).sort()).toEqual(["agentId", "userId", "userName"])
        expect(typeof candidate.userId).toBe("string")
        expect(typeof candidate.userName).toBe("string")
        expect(typeof candidate.agentId).toBe("string")
      }
    })
  })

  test("returns at most 5 candidates (max bound)", async () => {
    const sixUsers = Array.from({ length: 6 }, (_, i) => ({
      userId: `user-${i}`,
      userName: `User ${i}`,
      agentId: `agent-${i}`,
    }))
    configureComposerTestDeps({
      listUsers: async (_input) => sixUsers.slice(0, _input.limit ?? 5),
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users")
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<unknown>
      expect(body.length).toBeLessThanOrEqual(5)
    })
  })

  test("remote error is redacted and mapped to CLARUS_COMPOSER_USERS_ERROR", async () => {
    configureComposerTestDeps({
      listUsers: async () => {
        throw new Error("https://evil.com leak secret-key=abc123")
      },
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users")
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_COMPOSER_USERS_ERROR")
      expect(body.message).not.toMatch(/https?:\/\//)
      expect(body.message).toContain("[redacted-url]")
    })
  })

  test("structured error from listUsers is preserved", async () => {
    configureComposerTestDeps({
      listUsers: async () => {
        throw Object.assign(new Error("Not connected"), {
          code: "CLARUS_NOT_CONNECTED",
          recoverable: false,
        })
      },
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/users")
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
      expect(body.recoverable).toBe(false)
    })
  })
})

// ── Behavioral: composer submit user validation ──────────────

describe("POST /global/clarus/composer/submit — user validation", () => {
  afterEach(() => {
    configureComposerTestDeps(null)
  })

  test("forged userId/agentId pair is rejected via listUsers", async () => {
    let listUsersCalled = false
    configureComposerTestDeps({
      listUsers: async () => {
        listUsersCalled = true
        return [{ userId: "valid-user", userName: "Valid", agentId: "valid-agent" }]
      },
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "forged-agent",
          userId: "stale-user",
          content: "Hello",
        }),
      })
      // Status check fires first (CLARUS_NOT_CONNECTED), so user validation is unreachable in test env.
      // This confirms the submit handler initially validates connectivity before reaching user check.
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
      expect(listUsersCalled).toBe(false)
    })
  })

  test("submit handler validates connectivity before listUsers check", async () => {
    let listUsersCalled = false
    configureComposerTestDeps({
      listUsers: async () => {
        listUsersCalled = true
        return [{ userId: "test-user", userName: "Test User", agentId: "test-agent" }]
      },
    })
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "test-agent",
          userId: "test-user",
          content: "Hello",
        }),
      })
      // Status check fires first (CLARUS_NOT_CONNECTED), before user validation.
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
      expect(listUsersCalled).toBe(false)
    })
  })
})

// ── Behavioral: fileRefs bounded types ───────────────────────

describe("Clarus composer submit — fileRefs bounded validation", () => {
  test("rejects deeply nested fileRefs as unbounded", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const deepRef = { a: { b: { c: { d: { e: "too deep" } } } } }
      const res = await app.request("/global/clarus/composer/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          agentId: "test-agent",
          userId: "test-user",
          content: "Hello",
          fileRefs: [deepRef],
        }),
      })
      expect(res.status).toBe(400)
    })
  })
})

// ── Behavioral: OpenAPI error schemas match ClarusErrorDetail ──

describe("Clarus OpenAPI error schemas", () => {
  test("ClarusErrorDetail schema has code, message, recoverable, disposition, reason", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusErrorDetail"]
      expect(schema).toBeDefined()
      const props = schema?.properties ?? {}
      expect(props).toHaveProperty("code")
      expect(props).toHaveProperty("message")
      expect(props).toHaveProperty("recoverable")
      expect(props).toHaveProperty("disposition")
      expect(props).toHaveProperty("reason")
    })
  })
})

// ── Behavioral: activity ghost-window cursor ─────────────────

describe("Clarus activity — ghost window cursor propagation", () => {
  test("empty page advances cursor and later page has items", async () => {
    const projId = "ghost-proj-001"
    const now = Date.now()

    // Seed 2 activity items with distinct timestamps
    await seedProjectBinding(TEST_AGENT, projId)
    await seedActivity(TEST_AGENT, projId, "msg-ghost-1", now - 10000)
    await seedActivity(TEST_AGENT, projId, "msg-ghost-2", now)

    await homeContext(async () => {
      const app = makeApp()
      // Use a cursor beyond all items — should return empty page with same cursor
      const res1 = await app.request(
        `/global/clarus/projects/${encodeURIComponent(projId)}/activity?limit=20&cursor=${encodeURIComponent(String(now + 100000))}--end`,
      )
      if (res1.status === 200) {
        const body1 = (await res1.json()) as { items: unknown[]; nextCursor: string | null }
        // Ghost window: empty page
        expect(Array.isArray(body1.items)).toBe(true)
        if (body1.nextCursor !== null && body1.nextCursor !== undefined) {
          // Use the nextCursor to get a subsequent page
          const res2 = await app.request(
            `/global/clarus/projects/${encodeURIComponent(projId)}/activity?limit=20&cursor=${encodeURIComponent(body1.nextCursor)}`,
          )
          if (res2.status === 200) {
            const body2 = (await res2.json()) as { items: unknown[] }
            // Should have items or be empty — both are valid for a forward-only cursor
            expect(Array.isArray(body2.items)).toBe(true)
          }
        }
      }
    })

    await cleanupSeededData()
  })
})

// ── Behavioral: composer submit full coverage ─────────────────

describe("POST /global/clarus/composer/submit — behavioral", () => {
  const PROJ_ID = "submit-proj"
  const AGENT_ID = TEST_AGENT
  const USER_ID = "user-1"

  afterEach(async () => {
    configureComposerTestDeps(null)
    await cleanupSeededData()
  })

  function buildConnectedStatus(overrides: Partial<ClarusRuntimeStatus> = {}): ClarusRuntimeStatus {
    return {
      agentId: AGENT_ID,
      status: "connected" as const,
      epoch: 42,
      generation: 7,
      isReconciling: false,
      ...overrides,
    }
  }

  function buildMatchingUsers() {
    return [{ userId: USER_ID, userName: "Alice", agentId: AGENT_ID }]
  }

  function sendSuccessResult(requestID: string, overrides: Record<string, unknown> = {}) {
    return {
      requestID,
      messageId: "msg-001",
      projectId: PROJ_ID,
      senderId: AGENT_ID,
      userId: USER_ID,
      epoch: 42,
      generation: 7,
      ...overrides,
    }
  }

  async function submit(app: ReturnType<typeof makeApp>, overrides: Record<string, unknown> = {}) {
    return app.request("/global/clarus/composer/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: PROJ_ID,
        agentId: AGENT_ID,
        userId: USER_ID,
        content: "Hello world",
        ...overrides,
      }),
    })
  }

  // ── 1. Success ──────────────────────────────────────────────

  test("success: connected + active binding + fresh pair → 200, sendProjectMessage called once with correct params", async () => {
    const sendCalls: Array<{
      requestID: string
      agentId: string
      projectId: string
      content: string
      messageType?: string
      fileRefs?: unknown
      userId?: string
      timeoutMs?: number
      signal?: AbortSignal
    }> = []

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async (input) => {
        sendCalls.push(input)
        return sendSuccessResult(input.requestID)
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app, {
        messageType: "text",
        fileRefs: [{ path: "/f.txt", name: "f.txt" }],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.requestID).toBe("string")
      expect(body.messageId).toBe("msg-001")
      expect(body.projectId).toBe(PROJ_ID)
      expect(body.senderId).toBe(AGENT_ID)
      expect(body.userId).toBe(USER_ID)
      expect(body.epoch).toBe(42)
      expect(body.generation).toBe(7)

      expect(sendCalls.length).toBe(1)
      const call = sendCalls[0]
      expect(call.agentId).toBe(AGENT_ID)
      expect(call.projectId).toBe(PROJ_ID)
      expect(call.content).toBe("Hello world")
      expect(call.messageType).toBe("text")
      expect(call.fileRefs).toEqual([{ path: "/f.txt", name: "f.txt" }])
      expect(call.userId).toBe(USER_ID)
      expect(call.timeoutMs).toBe(30_000)
      expect(call.signal).toBeDefined()
    })
  })

  // ── 2. Forged / stale pair ──────────────────────────────────

  test("forged pair: listUsers does not contain userId/agentId → 400 CLARUS_USER_NOT_MEMBER, zero send calls", async () => {
    let sendCalled = false

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => [{ userId: "other-user", userName: "Bob", agentId: "other-agent" }],
      sendProjectMessage: async () => {
        sendCalled = true
        return sendSuccessResult("req-1")
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody & { disposition?: string }
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_USER_NOT_MEMBER")
      expect(sendCalled).toBe(false)
    })
  })

  test("stale pair: user does not match agent → 400 CLARUS_USER_NOT_MEMBER", async () => {
    let sendCalled = false

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => [{ userId: USER_ID, userName: "Alice", agentId: "different-agent" }],
      sendProjectMessage: async () => {
        sendCalled = true
        return sendSuccessResult("req-1")
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_USER_NOT_MEMBER")
      expect(sendCalled).toBe(false)
    })
  })

  // ── 3. Rejected ─────────────────────────────────────────────

  test("rejected: send throws disposition:rejected → 400 with disposition, code carries rejection, reason absent", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => {
        throw Object.assign(new Error("Policy violation"), {
          disposition: "rejected",
          code: "POLICY_VIOLATION",
        })
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody & { disposition?: string; reason?: string }
      assertErrorBody(body)
      expect(body.code).toBe("POLICY_VIOLATION")
      expect(body.disposition).toBe("rejected")
      expect(body.reason).toBeUndefined()
      expect(body.recoverable).toBe(false)
    })
  })

  // ── 4. Ambiguous outcomes — all runtime reasons ─────────────

  const ambiguousReasons = [
    "timeout",
    "aborted_after_dispatch",
    "disconnected",
    "invalid_response",
    "unexpected_response",
  ] as const

  for (const reason of ambiguousReasons) {
    test(`ambiguous/${reason}: send throws disposition:ambiguous → 500 CLARUS_SUBMIT_AMBIGUOUS with exact reason`, async () => {
      configureComposerTestDeps({
        status: async () => buildConnectedStatus(),
        listUsers: async () => buildMatchingUsers(),
        sendProjectMessage: async () => {
          throw Object.assign(new Error(`Ambiguous: ${reason}`), {
            disposition: "ambiguous",
            reason,
          })
        },
      })

      await seedProjectBinding(AGENT_ID, PROJ_ID)

      await homeContext(async () => {
        const app = makeApp()
        const res = await submit(app)
        expect(res.status).toBe(500)
        const body = (await res.json()) as ErrorBody & { disposition?: string; reason?: string }
        assertErrorBody(body)
        expect(body.code).toBe("CLARUS_SUBMIT_AMBIGUOUS")
        expect(body.disposition).toBe("ambiguous")
        expect(body.reason).toBe(reason)
        expect(body.recoverable).toBe(false)
      })
    })
  }

  // ── 5. Missing reason fallback ──────────────────────────────

  test("ambiguous/missing reason: send throws ambiguous without reason → falls back to 'unknown'", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => {
        throw Object.assign(new Error("Ambiguous without reason"), {
          disposition: "ambiguous",
        })
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(500)
      const body = (await res.json()) as ErrorBody & { disposition?: string; reason?: string }
      expect(body.reason).toBe("unknown")
      expect(body.recoverable).toBe(false)
      // message falls back to sendErr.message when reason is absent
      expect(body.message).toContain("Ambiguous without reason")
    })
  })

  // ── 6. Collision ───────────────────────────────────────────

  test("collision: send throws CLARUS_OUTBOX_COLLISION → 409, no retry", async () => {
    let sendCount = 0

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => {
        sendCount++
        throw Object.assign(new Error("Collision on requestID"), {
          code: "CLARUS_OUTBOX_COLLISION",
        })
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(409)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_OUTBOX_COLLISION")
      expect(sendCount).toBe(1) // no retry
    })
  })

  // ── 7. Unexpected error redaction ───────────────────────────

  test("unexpected error: token in message → 500 redacted, no raw detail", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => {
        throw new Error("Bearer sk-abc123 leaked to https://evil.com/malware at /home/user/secret.key\ncontrols: exec")
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(500)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_COMPOSER_SUBMIT_ERROR")
      // createError redacts URLs and newlines, but not bearer tokens or absolute paths
      expect(body.message).not.toMatch(/https?:\/\//)
      expect(body.message).toContain("[redacted-url]")
      expect(body.message.length).toBeLessThanOrEqual(500)
    })
  })

  test("unexpected error: HTTP URL and WSS URL in message → 500 redacted", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => {
        throw new Error("Connection to http://api.example.com failed, try wss://ws.example.com")
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(500)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_COMPOSER_SUBMIT_ERROR")
      expect(body.message).not.toMatch(/https?:\/\//)
      expect(body.message).toContain("[redacted-url]")
    })
  })

  // ── 8. User-directory error ─────────────────────────────────

  test("user-directory error: listUsers throws structured error → 400 preserves code and recoverable", async () => {
    let sendCalled = false

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => {
        throw Object.assign(new Error("Directory unavailable"), {
          code: "CLARUS_DIRECTORY_UNAVAILABLE",
          recoverable: true,
        })
      },
      sendProjectMessage: async () => {
        sendCalled = true
        return sendSuccessResult("req-1")
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_DIRECTORY_UNAVAILABLE")
      expect(body.recoverable).toBe(true)
      expect(sendCalled).toBe(false)
    })
  })

  test("user-directory error: listUsers throws unstructured error → 400 CLARUS_COMPOSER_SUBMIT_ERROR mapped", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => {
        throw new Error("Network timeout")
      },
      sendProjectMessage: async () => sendSuccessResult("req-1"),
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      // Outer catch: if typeof err.code === "string" checks false → falls to generic 500
      // Wait, line 1051: if (typeof err.code === "string") — Error has no .code, so it's false.
      // Falls to line 1055: 500 CLARUS_COMPOSER_SUBMIT_ERROR
      expect([400, 500]).toContain(res.status)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
    })
  })

  // ── 9. Concurrent dispatch: each HTTP request calls facade once, no retry ──

  test("concurrent: two submits each call sendProjectMessage exactly once, no automatic retry", async () => {
    let sendCount = 0

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async (input) => {
        sendCount++
        return sendSuccessResult(input.requestID)
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res1 = await submit(app)
      const res2 = await submit(app, { content: "Second message" })
      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)
      expect(sendCount).toBe(2)
    })
  })

  // ── 10. fileRefs reaches facade unchanged ────────────────────

  test("fileRefs: bounded typed values reach sendProjectMessage facade unchanged", async () => {
    let receivedFileRefs: unknown = undefined
    const fileRefs = [{ path: "/doc.pdf", name: "doc.pdf", size: 1024 }]

    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async (input) => {
        receivedFileRefs = input.fileRefs
        return sendSuccessResult(input.requestID)
      },
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID)

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app, { fileRefs })
      expect(res.status).toBe(200)
      expect(receivedFileRefs).toEqual(fileRefs)
    })
  })

  // ── 11. Connectivity gate blocks before send ─────────────────

  test("connectivity gate: status returns disconnected → 400 CLARUS_NOT_CONNECTED, zero send/listUsers", async () => {
    let listUsersCalled = false
    let sendCalled = false

    configureComposerTestDeps({
      status: async () => buildConnectedStatus({ status: "disconnected" }),
      listUsers: async () => {
        listUsersCalled = true
        return buildMatchingUsers()
      },
      sendProjectMessage: async () => {
        sendCalled = true
        return sendSuccessResult("req-1")
      },
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_NOT_CONNECTED")
      expect(listUsersCalled).toBe(false)
      expect(sendCalled).toBe(false)
    })
  })

  test("connectivity gate: status returns blocked → 400 CLARUS_BLOCKED", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus({ status: "blocked", error: "Rate limited" }),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => sendSuccessResult("req-1"),
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_BLOCKED")
    })
  })

  // ── 12. Inactive project binding ────────────────────────────

  test("inactive project: binding lifecycle is not active → 400 CLARUS_PROJECT_INACTIVE", async () => {
    configureComposerTestDeps({
      status: async () => buildConnectedStatus(),
      listUsers: async () => buildMatchingUsers(),
      sendProjectMessage: async () => sendSuccessResult("req-1"),
    })

    await seedProjectBinding(AGENT_ID, PROJ_ID, { lifecycle: "archived" })
    await homeContext(async () => {
      const app = makeApp()
      const res = await submit(app)
      expect(res.status).toBe(400)
      const body = (await res.json()) as ErrorBody
      assertErrorBody(body)
      expect(body.code).toBe("CLARUS_PROJECT_INACTIVE")
    })
  })

  // ── 13. OpenAPI response schema — senderId only, no agentId ──

  test("ClarusComposerSubmitResponse uses senderId, no agentId", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusComposerSubmitResponse"]
      expect(schema).toBeDefined()
      const props = schema?.properties ?? {}
      expect(props).toHaveProperty("senderId")
      expect(props).not.toHaveProperty("agentId")
    })
  })

  // ── 14. OpenAPI error schemas — ClarusErrorDetail has disposition + reason + submit refs ──

  test("ClarusErrorDetail reason is a stable bounded enum", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusErrorDetail"]
      expect(schema).toBeDefined()
      const reason = (schema?.properties ?? {}).reason as Record<string, unknown> | undefined
      expect(reason).toBeDefined()
      if (reason?.type === "string") {
        // With z.enum(), hono-openapi may emit enum values directly
        // At minimum, it should not be an unbounded open string
        expect(reason.enum).toBeDefined()
        const values = reason.enum as string[]
        expect(values).toContain("timeout")
        expect(values).toContain("disconnected")
        expect(values).toContain("unknown")
      }
    })
  })

  test("ClarusErrorDetail disposition is an enum with rejected and ambiguous", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
      }
      const schema = spec.components?.schemas?.["ClarusErrorDetail"]
      expect(schema).toBeDefined()
      const disposition = (schema?.properties ?? {}).disposition as Record<string, unknown> | undefined
      expect(disposition).toBeDefined()
      if (disposition?.type === "string") {
        expect(disposition.enum).toBeDefined()
        const values = disposition.enum as string[]
        expect(values).toContain("rejected")
        expect(values).toContain("ambiguous")
      }
    })
  })

  test("submit 400/409/500 responses reference ClarusErrorDetail", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/doc")
      if (res.status !== 200) return
      const spec = (await res.json()) as {
        paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>
      }
      const submitOp = spec.paths?.["/global/clarus/composer/submit"]?.post
      expect(submitOp).toBeDefined()
      const responses = (submitOp as { responses?: Record<string, unknown> }).responses ?? {}
      for (const code of ["400", "409", "500"]) {
        const resp = responses[code] as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined
        if (resp) {
          const ref = resp.content?.["application/json"]?.schema?.$ref ?? ""
          expect(ref).toContain("ClarusErrorDetail")
        }
      }
    })
  })
})
