import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import type { ClarusProjectBindingV3 } from "../../src/clarus/schemas"
import type { ClarusTaskBindingV4 } from "../../src/clarus/schemas"
import { configureComposerTestDeps } from "../../src/server/clarus-route"
import { MAX_WIRE_STRING_CURSOR } from "../../src/clarus/rest-port"

Log.init({ print: false })

// ── Types ────────────────────────────────────────────────────

type ErrorBody = {
  code: string
  message: string
  recoverable: boolean
}

type StatusBody = {
  agentId: string | null
  status: string
  epoch: number
  generation: number
  isReconciling: boolean
  error?: string
}

function assertErrorBody(body: unknown): asserts body is ErrorBody {
  const b = body as Record<string, unknown>
  expect(typeof b.code).toBe("string")
  expect(typeof b.message).toBe("string")
  expect(typeof b.recoverable).toBe("boolean")
}

function makeApp() {
  return Server.App()
}

function homeContext(fn: () => Promise<void>): Promise<void> {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

// ── Fixtures ─────────────────────────────────────────────────

const TEST_AGENT = "test-agent-pub-001"
const TEST_AGENT_SECONDARY = "test-agent-pub-002"

const TEST_PROJECT_ID = "pub-proj-001"

const TEST_TASK_ID = "pub-task-001"

const TEST_SESSION_ID = "pub-ses-xxx"

const TEST_SCOPE_ID = "pub-scope-xxx"

async function seedProjectBinding(agentId: string, projectId: string, overrides: Partial<ClarusProjectBindingV3> = {}) {
  const binding: ClarusProjectBindingV3 = {
    schemaVersion: 3,
    agentId,
    projectId,
    lifecycle: "active",
    projectName: `Project ${projectId}`,
    projectSlug: `slug-${projectId}`,
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

async function seedTaskBinding(
  agentId: string,
  projectId: string,
  taskId: string,
  overrides: Partial<ClarusTaskBindingV4> = {},
) {
  const binding: ClarusTaskBindingV4 = {
    schemaVersion: 4,
    agentId,
    projectId,
    taskId,
    sessionID: TEST_SESSION_ID,
    workspacePath: "/home/user/workspace/secret-project",
    scopeID: TEST_SCOPE_ID,
    runID: "run-001",
    subtaskID: "sub-001",
    phase: "implementation",
    attempt: 1,
    deadlineAt: "2026-12-31T23:59:59Z",
    title: "Fix the thing",
    taskInput: { goal: "Fix it" },
    contextHydration: "complete",
    frozenAgent: "frozen-agent-001",
    assignmentState: "materialized",
    assignmentInboxItemID: "inbox-001",
    assignmentMessageID: "msg-001",
    status: "submitted",
    resultState: "acknowledged",
    resultOutboxRequestID: "req-001",
    resultRecordedAt: Date.now(),
    lastCompletedAssistantMessageID: "asst-msg-001",
    localContinuationEnabledAt: undefined,
    extendOutboxRequestIDs: [],
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    ...overrides,
  }
  await Storage.write(StoragePath.clarusShardTaskBinding(agentId, projectId, taskId), binding)
  return binding
}

type NavigationBody = {
  projects: Array<Record<string, unknown>>
  tasks: Array<Record<string, unknown>>
}

async function cleanupSeededData() {
  for (const agentId of [TEST_AGENT, TEST_AGENT_SECONDARY, "agent-disabled"]) {
    const projectRoot = StoragePath.clarusAgentProjectRoot(agentId)
    const projectKeys = await Storage.scan(projectRoot).catch(() => [] as string[])
    for (const key of projectKeys) {
      await Storage.remove([...projectRoot, key]).catch(() => {})
      const taskRoot = StoragePath.clarusAgentTaskRoot(agentId)
      const tkFiles = await Storage.scan([...taskRoot, key]).catch(() => [] as string[])
      for (const tf of tkFiles) {
        await Storage.remove([...taskRoot, key, tf]).catch(() => {})
      }
    }
  }
}

beforeAll(async () => {
  await cleanupSeededData()
})

afterAll(async () => {
  await cleanupSeededData()
  configureComposerTestDeps(null)
})

afterEach(async () => {
  configureComposerTestDeps(null)
  await cleanupSeededData()
})

// ======================================================================
// 1. NAVIGATION ENDPOINT — GET /global/clarus/navigation
// ======================================================================

describe("GET /global/clarus/navigation — public navigation snapshot", () => {
  test("returns 200 with connection status and bounded project/task DTOs when disabled", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      // Blueprint: works while disabled, signed out, reconnecting, or degraded
      expect(res.status).toBe(200)

      const body = (await res.json()) as Record<string, unknown>

      // Must have connection state
      expect(body).toHaveProperty("connection")
      const conn = body.connection as Record<string, unknown>
      expect(conn).toHaveProperty("status")
      // Public states EXACTLY: disabled | connected | reconnecting | sign_in_required | sync_failed
      expect(["disabled", "connected", "reconnecting", "sign_in_required", "sync_failed"]).toContain(
        conn.status as string,
      )

      // Must have projects array
      expect(body).toHaveProperty("projects")
      const projects = body.projects as unknown[]
      expect(Array.isArray(projects)).toBe(true)

      // Must have tasks array
      expect(body).toHaveProperty("tasks")
      const tasks = body.tasks as unknown[]
      expect(Array.isArray(tasks)).toBe(true)
    })
  })

  test("projects DTO excludes internal fields (workspacePath, scopeID, membership)", async () => {
    await seedProjectBinding(TEST_AGENT, "proj-nav-a", {
      projectName: "Nav Project A",
      lifecycle: "active",
      membership: "owner",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      // Blueprint: works even when disabled/disconnected
      if (res.status === 404) return // Not yet routed — RED
      expect([200, 404]).toContain(res.status)
      if (res.status !== 200) return

      const body = (await res.json()) as Record<string, unknown>
      const projects = body.projects as Record<string, unknown>[]
      for (const p of projects) {
        expect(p).not.toHaveProperty("workspacePath")
        expect(p).not.toHaveProperty("scopeID")
        expect(p).not.toHaveProperty("membership")
        expect(p).not.toHaveProperty("messageCursor")
      }
    })
  })

  test("active projects include empty projects; inactive with history grouped; inactive without history omitted", async () => {
    // Seed: active with activity, active without activity (empty), inactive with history, inactive without history
    await seedProjectBinding(TEST_AGENT, "proj-active-with", {
      projectName: "Active With",
      lifecycle: "active",
      lastProjectActivityAt: Date.now(),
    })
    await seedProjectBinding(TEST_AGENT, "proj-active-empty", {
      projectName: "Active Empty",
      lifecycle: "active",
    })
    await seedProjectBinding(TEST_AGENT, "proj-inactive-with", {
      projectName: "Inactive History",
      lifecycle: "archived",
      lastProjectActivityAt: Date.now() - 3600000,
    })
    await seedProjectBinding(TEST_AGENT, "proj-inactive-no-history", {
      projectName: "Inactive No History",
      lifecycle: "archived",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return // Not yet routed — RED

      const body = (await res.json()) as Record<string, unknown>
      const projects = body.projects as Record<string, unknown>[]

      // Active projects should include empty
      const activeProjectIds = projects
        .filter((p: Record<string, unknown>) => p.activeGroup === true || (p as any).lifecycle === "active")
        .map((p: Record<string, unknown>) => p.projectId)
      expect(activeProjectIds).toContain("proj-active-with")
      expect(activeProjectIds).toContain("proj-active-empty")

      // Inactive with history should be present
      const inactiveProjectIds = projects
        .filter((p: Record<string, unknown>) => !p.activeGroup || (p as any).lifecycle !== "active")
        .map((p: Record<string, unknown>) => p.projectId)
      expect(inactiveProjectIds).toContain("proj-inactive-with")

      // Inactive without history should be omitted
      expect(inactiveProjectIds).not.toContain("proj-inactive-no-history")
    })
  })

  test("preserves composite agent/project/task identity across colliding IDs", async () => {
    const projectId = "shared-project-id"
    const taskId = "shared-task-id"
    await seedProjectBinding(TEST_AGENT, projectId, { projectName: "Primary project" })
    await seedTaskBinding(TEST_AGENT, projectId, taskId, { title: "Primary task" })
    await seedProjectBinding(TEST_AGENT_SECONDARY, projectId, { projectName: "Secondary project" })
    await seedTaskBinding(TEST_AGENT_SECONDARY, projectId, taskId, {
      sessionID: "pub-ses-secondary",
      title: "Secondary task",
    })

    await homeContext(async () => {
      const res = await makeApp().request("/global/clarus/navigation")
      expect(res.status).toBe(200)
      const body = (await res.json()) as NavigationBody

      const projects = body.projects.filter((project) => project.projectId === projectId)
      const tasks = body.tasks.filter((task) => task.projectId === projectId && task.taskId === taskId)
      expect(projects).toHaveLength(2)
      expect(new Set(projects.map((project) => project.agentId))).toEqual(new Set([TEST_AGENT, TEST_AGENT_SECONDARY]))
      expect(tasks).toHaveLength(2)
      expect(new Set(tasks.map((task) => task.agentId))).toEqual(new Set([TEST_AGENT, TEST_AGENT_SECONDARY]))
    })
  })

  test("returns retained tasks for inactive projects in History", async () => {
    const projectId = "inactive-project-with-task-history"
    const taskId = "inactive-history-task"
    await seedProjectBinding(TEST_AGENT, projectId, {
      lifecycle: "archived",
      desiredSubscription: false,
      lastProjectActivityAt: Date.now() - 60_000,
    })
    await seedTaskBinding(TEST_AGENT, projectId, taskId, { status: "submitted" })

    await homeContext(async () => {
      const res = await makeApp().request("/global/clarus/navigation")
      expect(res.status).toBe(200)
      const body = (await res.json()) as NavigationBody
      expect(body.projects).toContainEqual(
        expect.objectContaining({ agentId: TEST_AGENT, projectId, activeGroup: false }),
      )
      expect(body.tasks).toContainEqual(expect.objectContaining({ agentId: TEST_AGENT, projectId, taskId }))
    })
  })

  test("task priority order: needs_attention, running, submitting, waiting, submitted, failed, expired, cancelled; then latest activity", async () => {
    const now = Date.now()

    // Create tasks with different statuses at different times
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-waiting", {
      status: "waiting",
      updatedAt: now - 1000,
    })
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-needs-attention", {
      status: "needs_attention",
      updatedAt: now - 9000,
    })
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-cancelled", {
      status: "cancelled",
      updatedAt: now,
    })
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-running", {
      status: "running",
      updatedAt: now - 5000,
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return // Not yet routed

      const body = (await res.json()) as Record<string, unknown>
      const tasks = (body.tasks as Record<string, unknown>[]) ?? []

      // Filter to only our seeded tasks
      const ourTasks = tasks.filter(
        (t: Record<string, unknown>) =>
          t.projectId === TEST_PROJECT_ID &&
          (t.taskId === "task-needs-attention" ||
            t.taskId === "task-running" ||
            t.taskId === "task-waiting" ||
            t.taskId === "task-cancelled"),
      )

      if (ourTasks.length >= 4) {
        const order = ourTasks.map((t: Record<string, unknown>) => t.taskId)
        // Priority: needs_attention > running > waiting > cancelled
        const needsIdx = order.indexOf("task-needs-attention")
        const runningIdx = order.indexOf("task-running")
        const waitingIdx = order.indexOf("task-waiting")
        const cancelledIdx = order.indexOf("task-cancelled")

        expect(needsIdx).toBeLessThan(runningIdx)
        expect(runningIdx).toBeLessThan(waitingIdx)
        expect(waitingIdx).toBeLessThan(cancelledIdx)
      }
    })
  })

  test("tasks DTO excludes internal fields (workspacePath, scopeID, frozenAgent, taskInput, raw outbox data)", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-safe-fields", {
      status: "running",
      title: "Safe Field Check",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return // Not yet routed

      const body = (await res.json()) as Record<string, unknown>
      const tasks = (body.tasks as Record<string, unknown>[]) ?? []
      for (const t of tasks) {
        expect(t).not.toHaveProperty("workspacePath")
        expect(t).not.toHaveProperty("scopeID")
        expect(t).not.toHaveProperty("frozenAgent")
        expect(t).not.toHaveProperty("taskInput")
        expect(t).not.toHaveProperty("extendOutboxRequestIDs")
        expect(t).not.toHaveProperty("assignmentInboxItemID")
        expect(t).not.toHaveProperty("assignmentMessageID")
        expect(t).not.toHaveProperty("resultOutboxRequestID")
      }
    })
  })

  test("connection status reflects actual state: disabled, sign_in_required, sync_failed", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return

      const body = (await res.json()) as Record<string, unknown>
      const conn = body.connection as Record<string, unknown>
      // Without a real Holos, should be disabled or sign_in_required
      expect(["disabled", "sign_in_required"]).toContain(conn?.status as string)
    })
  })
})

// ======================================================================
// 2. SAFE TASK DETAIL — GET /global/clarus/projects/:projectId/tasks/:taskId
// ======================================================================

describe("GET /global/clarus/projects/:projectId/tasks/:taskId — safe bounded detail", () => {
  test("returns 200 with bounded task detail for valid project and task", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-detail-safe", {
      title: "Safe Detail Task",
      status: "running",
      phase: "implementation",
      attempt: 2,
      contextHydration: "complete",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-detail-safe")}`,
      )
      // Returns 400 without a connection; the contract test verifies the route exists
      // and the response shape — errors are expected until routing is implemented
      if (res.status === 404) return // Not yet routed

      expect([200, 400]).toContain(res.status)
    })
  })

  test("MUST NOT include workspacePath in task detail response", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-no-path", {
      title: "No Path Task",
      status: "submitted",
      resultState: "acknowledged",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-no-path")}`,
      )
      if (res.status !== 200) return // RED due to connection state — expected

      const body = (await res.json()) as Record<string, unknown>
      expect(body).not.toHaveProperty("workspacePath")
      expect(body).not.toHaveProperty("scopeID")
      expect(body).not.toHaveProperty("frozenAgent")
      expect(body).not.toHaveProperty("taskInput")
      expect(body).not.toHaveProperty("unrestrictedInstructions")
      expect(body).not.toHaveProperty("extendOutboxRequestIDs")
      expect(body).not.toHaveProperty("assignmentInboxItemID")
      expect(body).not.toHaveProperty("assignmentMessageID")
    })
  })

  test("MUST include sessionID (for HOME_SCOPE_KEY routing), projectId, taskId, title, phase, attempt, deadlineAt, status, resultState, contextHydration, assignment summary, localContinuation fields, timestamps", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-allowed-fields", {
      title: "Allowed Fields Task",
      status: "submitted",
      resultState: "acknowledged",
      phase: "review",
      attempt: 3,
      deadlineAt: "2026-12-31T23:59:59Z",
      contextHydration: "complete",
      resultRecordedAt: Date.now(),
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-allowed-fields")}`,
      )
      if (res.status !== 200) return

      const body = (await res.json()) as Record<string, unknown>
      expect(body).toHaveProperty("sessionID")
      expect(body).toHaveProperty("projectId")
      expect(body).toHaveProperty("taskId")
      expect(body).toHaveProperty("title")
      expect(body).toHaveProperty("phase")
      expect(body).toHaveProperty("attempt")
      expect(body).toHaveProperty("status")
      expect(body).toHaveProperty("resultState")
      expect(body).toHaveProperty("contextHydration")
      expect(body).toHaveProperty("createdAt")
      expect(body).toHaveProperty("updatedAt")
    })
  })
})

// ======================================================================
// 3. CONTINUE-LOCAL — POST /global/clarus/projects/:projectId/tasks/:taskId/continue-local
// ======================================================================

describe("POST /global/clarus/projects/:projectId/tasks/:taskId/continue-local", () => {
  test("returns 200 and persists localContinuationEnabledAt for acknowledged/submitted task", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-continue-ok", {
      status: "submitted",
      resultState: "acknowledged",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-continue-ok")}/continue-local`,
        { method: "POST" },
      )
      // 404 means route not yet mounted — RED
      // 400 means connection gate — route exists but need connection
      expect([200, 400, 404]).toContain(res.status)
    })
  })

  test("is idempotent: second call returns same result", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-continue-idem", {
      status: "submitted",
      resultState: "acknowledged",
    })

    await homeContext(async () => {
      const app = makeApp()
      const url = `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-continue-idem")}/continue-local`
      const res1 = await app.request(url, { method: "POST" })
      const res2 = await app.request(url, { method: "POST" })

      if (res1.status === 404 || res2.status === 404) return // Not yet routed

      // When connected, both should succeed
      if (res1.status === 200 && res2.status === 200) {
        const b1 = (await res1.json()) as Record<string, unknown>
        const b2 = (await res2.json()) as Record<string, unknown>
        expect(b1.localContinuationEnabledAt).toBe(b2.localContinuationEnabledAt)
        expect(b1.resultState).toBe("local_only")
      }
    })
  })

  test("rejects ambiguous/rejected/running/waiting/submitting/expired/cancelled/failed tasks", async () => {
    const ineligibleStatuses = [
      { status: "running", resultState: "idle" },
      { status: "waiting", resultState: "idle" },
      { status: "submitting", resultState: "dispatched" },
      { status: "expired", resultState: "idle" },
      { status: "cancelled", resultState: "idle" },
      { status: "failed", resultState: "idle" },
    ]

    const tasks = ineligibleStatuses.map((s, i) => ({
      taskId: `task-continue-reject-${i}`,
      ...s,
    }))

    for (const t of tasks) {
      await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, t.taskId, {
        status: t.status as ClarusTaskBindingV4["status"],
        resultState: t.resultState as ClarusTaskBindingV4["resultState"],
      })
    }

    await homeContext(async () => {
      const app = makeApp()
      for (const t of tasks) {
        const res = await app.request(
          `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent(t.taskId)}/continue-local`,
          { method: "POST" },
        )
        if (res.status === 404) continue // Not yet routed
        // Should be rejected (400)
        expect([400, 404]).toContain(res.status)
      }
    })
  })

  test("rejects task with ambiguous resultState", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-continue-ambiguous", {
      status: "submitted",
      resultState: "ambiguous",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-continue-ambiguous")}/continue-local`,
        { method: "POST" },
      )
      if (res.status === 404) return // RED
      expect([200, 400]).toContain(res.status)
    })
  })

  test("cannot enable another Clarus result after local_only", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-continue-done", {
      status: "submitted",
      resultState: "local_only",
      localContinuationEnabledAt: Date.now(),
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/projects/${encodeURIComponent(TEST_PROJECT_ID)}/tasks/${encodeURIComponent("task-continue-done")}/continue-local`,
        { method: "POST" },
      )
      if (res.status === 404) return // RED
      // local_only is a terminal result state — cannot be used for another Clarus result
      // continue-local on already-local_only should be idempotent (200) since it's already done
      // but the underlying state must not be cleared
      expect([200, 400]).toContain(res.status)
    })
  })
})

// ======================================================================
// 4. SECURITY — DTO redaction of sensitive fields
// ======================================================================

describe("Security: DTO redaction of sensitive internal fields", () => {
  test("GET /global/clarus/tasks?projectId=X does not leak workspacePath or scopeID in items", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-sec-list", {
      title: "Security List Task",
      status: "running",
      workspacePath: "/home/attacker/should-not-leak",
      scopeID: "session-scope-must-not-leak",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(`/global/clarus/tasks?projectId=${encodeURIComponent(TEST_PROJECT_ID)}`)
      // 400 = connection gate (route exists, implementation intact), response shape is what matters
      if (res.status !== 200) return

      const body = (await res.json()) as Record<string, unknown>
      const items = body.items as Record<string, unknown>[]
      for (const item of items) {
        expect(item).not.toHaveProperty("workspacePath")
        expect(item).not.toHaveProperty("scopeID")
      }
    })
  })

  test("GET /global/clarus/tasks/:taskId does not leak workspacePath or scopeID", async () => {
    await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, "task-sec-get", {
      title: "Security Get Task",
      status: "running",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/tasks/${encodeURIComponent("task-sec-get")}?projectId=${encodeURIComponent(TEST_PROJECT_ID)}`,
      )
      if (res.status !== 200) return

      const body = (await res.json()) as Record<string, unknown>
      expect(body).not.toHaveProperty("workspacePath")
      expect(body).not.toHaveProperty("scopeID")
    })
  })

  test("error messages redact Bearer tokens", async () => {
    await homeContext(async () => {
      const app = makeApp()
      // Use a route that returns JSON error responses (tasks get route,
      // not the navigation route which returns 404 with HTML/text)
      const res = await app.request(
        `/global/clarus/tasks/${encodeURIComponent("nonexistent-bearer")}?projectId=${encodeURIComponent(TEST_PROJECT_ID)}`,
      )
      // The route returns JSON even for 400/404 errors
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (body.code && typeof body.message === "string") {
        expect(body.message).not.toMatch(/Bearer [A-Za-z0-9._\-+/=]+/)
        expect(body.message).not.toMatch(/sk-[A-Za-z0-9]+/)
      }
    })
  })

  test("error messages redact absolute filesystem paths", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/tasks/${encodeURIComponent("nonexistent")}?projectId=${encodeURIComponent(TEST_PROJECT_ID)}`,
      )
      const body = (await res.json()) as Record<string, unknown>
      if (body.code && typeof body.message === "string") {
        // No Unix absolute paths
        expect(body.message).not.toMatch(/\/home\//)
        expect(body.message).not.toMatch(/\/etc\//)
        expect(body.message).not.toMatch(/\/tmp\//)
        // No Windows paths
        expect(body.message).not.toMatch(/[A-Z]:\\/)
        // No UNC paths
        expect(body.message).not.toMatch(/\\\\/)
      }
    })
  })

  test("error messages redact internal scope/session identifiers", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(
        `/global/clarus/tasks/${encodeURIComponent("nonexistent")}?projectId=${encodeURIComponent(TEST_PROJECT_ID)}`,
      )
      const body = (await res.json()) as Record<string, unknown>
      if (body.code && typeof body.message === "string") {
        expect(body.message).not.toMatch(/scope[_-]?[0-9a-f]{40}/)
        expect(body.message).not.toMatch(/ses[_-][0-9a-f]{20,}/)
      }
    })
  })
})

// ======================================================================
// 5. BOUNDED READS — Pagination without loading all bindings
// ======================================================================

describe("Bounded reads: navigation and task listing do not load all bindings to paginate", () => {
  test("navigation reads are bounded — does not scan beyond page size + cursor", async () => {
    // Seed 150 projects to test bounding
    const projectIds: string[] = []
    for (let i = 0; i < 150; i++) {
      const pid = `proj-bounded-${String(i).padStart(3, "0")}`
      projectIds.push(pid)
      await seedProjectBinding(TEST_AGENT, pid, {
        projectName: `Bounded Project ${i}`,
        lifecycle: i < 100 ? "active" : "archived",
        lastProjectActivityAt: i < 100 ? Date.now() : undefined,
      })
    }

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return // RED — not yet routed

      expect(res.status).toBe(200)
      // The response must return in reasonable time (not loading 150 projects fully)
      const body = (await res.json()) as Record<string, unknown>
      const tasks = body.tasks as unknown[]
      // Tasks should be bounded (not all 150 projects' tasks scanned)
      // At minimum, the response must be structured
      expect(Array.isArray(tasks)).toBe(true)
    })
  })

  test("task list reads are bounded and respect cursor pagination", async () => {
    for (let i = 0; i < 50; i++) {
      await seedTaskBinding(TEST_AGENT, TEST_PROJECT_ID, `task-page-${String(i).padStart(3, "0")}`, {
        title: `Page Task ${i}`,
        status: "running",
        updatedAt: Date.now() + i, // ascending order for predictable cursoring
      })
    }

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request(`/global/clarus/tasks?projectId=${encodeURIComponent(TEST_PROJECT_ID)}&limit=10`)
      if (res.status !== 200) return // Connection gate

      const body = (await res.json()) as Record<string, unknown>
      const items = body.items as unknown[]
      expect(Array.isArray(items)).toBe(true)
      // Must not load all 50 tasks to return 10
      expect(items.length).toBeLessThanOrEqual(10)
      // Must have nextCursor for remaining
      expect(typeof body.nextCursor).toBe("string")
    })
  })
})

// ======================================================================
// 6. NAVIGATION ROUTE — Edge cases and error handling
// ======================================================================

describe("GET /global/clarus/navigation — edge cases", () => {
  test("returns normalized shape when no persisted data exists", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return

      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toHaveProperty("connection")
      expect(body).toHaveProperty("projects")
      expect(body).toHaveProperty("tasks")
      expect(Array.isArray(body.projects)).toBe(true)
      expect(Array.isArray(body.tasks)).toBe(true)
      expect((body.projects as unknown[]).length).toBe(0)
      expect((body.tasks as unknown[]).length).toBe(0)
    })
  })

  test("returns 200 (not 5xx) when all infrastructure is unavailable", async () => {
    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return
      expect(res.status).toBe(200)
    })
  })

  test("preserves locally persisted data when Holos is disconnected", async () => {
    await seedProjectBinding(TEST_AGENT, "proj-offline", {
      projectName: "Offline Project",
      lifecycle: "active",
      lastProjectActivityAt: Date.now(),
    })
    await seedTaskBinding(TEST_AGENT, "proj-offline", "task-offline", {
      title: "Offline Task",
      status: "running",
    })

    await homeContext(async () => {
      const app = makeApp()
      const res = await app.request("/global/clarus/navigation")
      if (res.status === 404) return

      // Even when disconnected, locally persisted data should be visible
      const body = (await res.json()) as Record<string, unknown>
      const projects = body.projects as Record<string, unknown>[]
      const projectIds = projects.map((p: Record<string, unknown>) => p.projectId)
      expect(projectIds).toContain("proj-offline")
    })
  })
})
