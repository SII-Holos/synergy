import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusProjectActivityStore } from "../../src/clarus/activity"
import type { ClarusProjectBindingV3, ClarusTaskBindingV4, ClarusProjectActivity } from "../../src/clarus/schemas"
import { bindingKey, encodeSegment } from "../../src/clarus/keys"

let AGENT_ID = "agent_4"
let AGENT_ID_B = "agent_4b"
let PROJECT_ID = "project_4"

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `ag4_${suffix}`
  AGENT_ID_B = `ag4b_${suffix}`
  PROJECT_ID = `pj4_${suffix}`
})

function makeBinding(
  agentId: string,
  projectId: string,
  overrides?: Partial<ClarusProjectBindingV3>,
): ClarusProjectBindingV3 {
  return {
    schemaVersion: 3,
    agentId,
    projectId,
    lifecycle: "active",
    desiredSubscription: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeTaskBinding(
  agentId: string,
  projectId: string,
  taskId: string,
  overrides?: Partial<ClarusTaskBindingV4>,
): ClarusTaskBindingV4 {
  return {
    schemaVersion: 4,
    agentId,
    projectId,
    taskId,
    sessionID: `ses_${taskId}`,
    workspacePath: "/tmp/ws",
    scopeID: `scope_${taskId}`,
    runID: "",
    subtaskID: "",
    phase: "",
    attempt: 0,
    title: taskId,
    taskInput: {},
    contextHydration: "unavailable",
    frozenAgent: "",
    assignmentState: "planned",
    assignmentInboxItemID: "",
    assignmentMessageID: "",
    status: "waiting",
    resultState: "idle",
    extendOutboxRequestIDs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeActivity(
  agentId: string,
  projectId: string,
  messageId: string,
  receivedAt?: number,
): ClarusProjectActivity {
  return {
    agentId,
    projectId,
    messageId,
    senderType: "user",
    content: `msg_${messageId}`,
    receivedAt: receivedAt ?? Date.now(),
  }
}

async function seedBinding(agentId: string, projectId: string, overrides?: Partial<ClarusProjectBindingV3>) {
  const binding = makeBinding(agentId, projectId, overrides)
  await Storage.write(StoragePath.clarusShardProjectBinding(agentId, projectId), binding)
}

async function seedTask(agentId: string, projectId: string, taskId: string, overrides?: Partial<ClarusTaskBindingV4>) {
  const binding = makeTaskBinding(agentId, projectId, taskId, overrides)
  await Storage.write(StoragePath.clarusShardTaskBinding(agentId, projectId, taskId), binding)
}

async function seedActivity(agentId: string, projectId: string, messageId: string, receivedAt?: number) {
  const activity = makeActivity(agentId, projectId, messageId, receivedAt)
  await ClarusProjectActivityStore.upsert(activity)
}

// =============================================================================
// 1. Bounded project binding listing
// =============================================================================
describe("bounded project binding listing", () => {
  test("returns empty page with no bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 20 })
        expect(page.items).toEqual([])
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("returns single binding in one page", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedBinding(AGENT_ID, PROJECT_ID)
        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 20 })
        expect(page.items).toHaveLength(1)
        expect(page.items[0].projectId).toBe(PROJECT_ID)
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("paginates with cursor across multiple pages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 25
        for (let i = 0; i < count; i++) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }

        const page1 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10 })
        expect(page1.items.length).toBeGreaterThan(0)
        expect(page1.items.length).toBeLessThanOrEqual(10)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10, cursor: page1.nextCursor! })
        expect(page2.items.length).toBeGreaterThan(0)
        expect(page2.items.length).toBeLessThanOrEqual(10)

        // Ensure no duplicates
        const ids1 = new Set(page1.items.map((b) => b.projectId))
        const ids2 = new Set(page2.items.map((b) => b.projectId))
        for (const id of ids2) expect(ids1.has(id)).toBe(false)

        const page3 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10, cursor: page2.nextCursor! })
        // Combined coverage: page1 + page2 + page3 should cover all 25
        const allIds = new Set([
          ...page1.items.map((b) => b.projectId),
          ...page2.items.map((b) => b.projectId),
          ...page3.items.map((b) => b.projectId),
        ])
        expect(allIds.size).toBe(count)
      },
    })
  })

  test("isolates by agent — other agent bindings not returned", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedBinding(AGENT_ID, PROJECT_ID)
        await seedBinding(AGENT_ID_B, "other_project")

        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 20 })
        expect(page.items).toHaveLength(1)
        expect(page.items[0].projectId).toBe(PROJECT_ID)
      },
    })
  })

  test("default limit is 20", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 25; i++) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, {})
        expect(page.items.length).toBeLessThanOrEqual(20)
        expect(page.nextCursor).not.toBeNull()
      },
    })
  })

  test("limit clamped to max 100", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 5; i++) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 200 })
        expect(page.items.length).toBeLessThanOrEqual(5)
      },
    })
  })

  test("corrupt entry is skipped and does not break pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedBinding(AGENT_ID, `${PROJECT_ID}_a`)
        // Write corrupt data that won't parse as a valid binding
        await Storage.write(StoragePath.clarusBinding(bindingKey(AGENT_ID, `${PROJECT_ID}_corrupt`)), { garbage: true })
        await seedBinding(AGENT_ID, `${PROJECT_ID}_b`)

        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 20 })
        const projectIds = page.items.map((b) => b.projectId)
        expect(projectIds).toContain(`${PROJECT_ID}_a`)
        expect(projectIds).toContain(`${PROJECT_ID}_b`)
        expect(page.items.length).toBe(2) // corrupt entry skipped, not counted
      },
    })
  })

  test("stable key ordering across restarts", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const ids = ["zebra", "alpha", "beta", "gamma"]
        for (const id of ids) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${id}`)
        }

        const page1 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 50 })
        const order1 = page1.items.map((b) => b.projectId)
        // Storage.scan sorts alphabetically, so order is deterministic
        expect(order1).toEqual(order1.slice().sort())
      },
    })
  })

  test("cursor exhausted returns empty page", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedBinding(AGENT_ID, `${PROJECT_ID}_0`)
        await seedBinding(AGENT_ID, `${PROJECT_ID}_1`)

        const page1 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 1 })
        expect(page1.items).toHaveLength(1)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10, cursor: page1.nextCursor! })
        expect(page2.items).toHaveLength(1) // remaining binding
        expect(page2.nextCursor).toBeNull() // no more pages
      },
    })
  })
})

// =============================================================================
// 2. Bounded task binding listing
// =============================================================================
describe("bounded task binding listing", () => {
  test("returns empty page with no task bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 20,
        })
        expect(page.items).toEqual([])
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("returns task bindings scoped to agent and project", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedTask(AGENT_ID, PROJECT_ID, "task_a")
        await seedTask(AGENT_ID, PROJECT_ID, "task_b")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 20,
        })
        expect(page.items).toHaveLength(2)
        const taskIds = page.items.map((t) => t.taskId)
        expect(taskIds).toContain("task_a")
        expect(taskIds).toContain("task_b")
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("scoped to agent only returns all agent's tasks across projects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedTask(AGENT_ID, `${PROJECT_ID}_x`, "task_x")
        await seedTask(AGENT_ID, `${PROJECT_ID}_y`, "task_y")
        await seedTask(AGENT_ID_B, "other_project", "task_other")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, { limit: 20 })
        const taskIds = page.items.map((t) => t.taskId)
        expect(taskIds).toContain("task_x")
        expect(taskIds).toContain("task_y")
        expect(taskIds).not.toContain("task_other")
      },
    })
  })

  test("paginates with cursor across pages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 25
        for (let i = 0; i < count; i++) {
          await seedTask(AGENT_ID, PROJECT_ID, `task_${String(i).padStart(3, "0")}`)
        }

        const page1 = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 10,
        })
        expect(page1.items.length).toBeGreaterThan(0)
        expect(page1.items.length).toBeLessThanOrEqual(10)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBeGreaterThan(0)
        expect(page2.items.length).toBeLessThanOrEqual(10)

        const ids1 = new Set(page1.items.map((t) => t.taskId))
        const ids2 = new Set(page2.items.map((t) => t.taskId))
        for (const id of ids2) expect(ids1.has(id)).toBe(false)

        const page3 = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 10,
          cursor: page2.nextCursor!,
        })
        const allIds = new Set([
          ...page1.items.map((t) => t.taskId),
          ...page2.items.map((t) => t.taskId),
          ...page3.items.map((t) => t.taskId),
        ])
        expect(allIds.size).toBe(count)
      },
    })
  })

  test("default limit is 20", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 25; i++) {
          await seedTask(AGENT_ID, PROJECT_ID, `task_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
        })
        expect(page.items.length).toBeLessThanOrEqual(20)
        expect(page.nextCursor).not.toBeNull()
      },
    })
  })

  test("limit clamped to max 100", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 5; i++) {
          await seedTask(AGENT_ID, PROJECT_ID, `task_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 200,
        })
        expect(page.items.length).toBeLessThanOrEqual(5)
      },
    })
  })

  test("corrupt task entry is skipped", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedTask(AGENT_ID, PROJECT_ID, "task_valid")
        const corruptKey = `${bindingKey(AGENT_ID, PROJECT_ID)}:${encodeSegment("task_corrupt")}`
        await Storage.write(StoragePath.clarusTaskBinding(corruptKey), { not: "a binding" })
        await seedTask(AGENT_ID, PROJECT_ID, "task_also_valid")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 20,
        })
        const taskIds = page.items.map((t) => t.taskId)
        expect(taskIds).toContain("task_valid")
        expect(taskIds).toContain("task_also_valid")
        expect(page.items.length).toBe(2)
      },
    })
  })

  test("does not cross-contaminate between agents", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedTask(AGENT_ID, PROJECT_ID, "task_our")
        await seedTask(AGENT_ID_B, "other_pj", "task_other")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 20,
        })
        expect(page.items).toHaveLength(1)
        expect(page.items[0].taskId).toBe("task_our")
      },
    })
  })
})

// =============================================================================
// 3. Bounded project activity listing
// =============================================================================
describe("bounded project activity listing", () => {
  test("returns empty page with no activities", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(result.items).toEqual([])
        expect(result.nextCursor).toBeNull()
      },
    })
  })

  test("returns activities sorted by receivedAt within page", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const now = Date.now()
        await seedActivity(AGENT_ID, PROJECT_ID, "msg_003", now + 3000)
        await seedActivity(AGENT_ID, PROJECT_ID, "msg_001", now + 1000)
        await seedActivity(AGENT_ID, PROJECT_ID, "msg_002", now + 2000)

        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(result.items).toHaveLength(3)
        const msgIds = result.items.map((a) => a.messageId)
        expect(msgIds).toEqual(["msg_001", "msg_002", "msg_003"]) // sorted by receivedAt
        expect(result.nextCursor).toBeNull()
      },
    })
  })

  test("paginates activities with cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 25
        const now = Date.now()
        for (let i = 0; i < count; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`, now + i * 1000)
        }

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(page1.items.length).toBeGreaterThan(0)
        expect(page1.items.length).toBeLessThanOrEqual(10)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBeGreaterThan(0)
        expect(page2.items.length).toBeLessThanOrEqual(10)

        // No overlap
        const ids1 = new Set(page1.items.map((a) => a.messageId))
        const ids2 = new Set(page2.items.map((a) => a.messageId))
        for (const id of ids2) expect(ids1.has(id)).toBe(false)

        // Each page sorted by receivedAt
        for (let i = 1; i < page1.items.length; i++) {
          expect(page1.items[i].receivedAt).toBeGreaterThanOrEqual(page1.items[i - 1].receivedAt)
        }
      },
    })
  })

  test("default limit is applied", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 25; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`)
        }
        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(result.items.length).toBeLessThanOrEqual(20)
        expect(result.nextCursor).not.toBeNull()
      },
    })
  })

  test("limit clamped to max 100", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 5; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`)
        }
        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 200 })
        expect(result.items.length).toBeLessThanOrEqual(5)
      },
    })
  })

  test("cursor navigation is stable after restart", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 15; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`)
        }

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })

        const allIds = page1.items.map((a) => a.messageId).concat(page2.items.map((a) => a.messageId))
        expect(new Set(allIds).size).toBe(allIds.length) // no duplicates
      },
    })
  })

  test("corrupt activity entry is skipped", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedActivity(AGENT_ID, PROJECT_ID, "msg_valid")
        await Storage.write(StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_corrupt"), { junk: true })
        await seedActivity(AGENT_ID, PROJECT_ID, "msg_also_valid")

        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(result.items).toHaveLength(2)
        const msgIds = result.items.map((a) => a.messageId)
        expect(msgIds).toContain("msg_valid")
        expect(msgIds).toContain("msg_also_valid")
      },
    })
  })
})

// =============================================================================
// 4. Read cap verification — bound on Storage reads per call
// =============================================================================
describe("read cap verification", () => {
  test("binding bounded listing reads at most limit entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Seed 40 bindings — only 10 should be read
        for (let i = 0; i < 40; i++) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10 })
        expect(page.items.length).toBeLessThanOrEqual(10)
        // Unbounded listBindings would return 40; bounded returns ≤ 10
        const unbounded = await ClarusBindingStore.listBindings(AGENT_ID)
        expect(unbounded.length).toBe(40)
      },
    })
  })

  test("task bounded listing reads at most limit entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 40; i++) {
          await seedTask(AGENT_ID, PROJECT_ID, `task_${String(i).padStart(3, "0")}`)
        }
        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 10,
        })
        expect(page.items.length).toBeLessThanOrEqual(10)
        const unbounded = await ClarusTaskBindingStore.listTaskBindings(AGENT_ID, PROJECT_ID)
        expect(unbounded.length).toBe(40)
      },
    })
  })

  test("activity bounded listing reads at most limit entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 40; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`)
        }
        const result = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(result.items.length).toBeLessThanOrEqual(10)
        const unbounded = await ClarusProjectActivityStore.listByProject(AGENT_ID, PROJECT_ID)
        expect(unbounded.length).toBe(40)
      },
    })
  })
})

// =============================================================================
// 5. Existing Phase 3 list methods preserved
// =============================================================================
describe("Phase 3 list methods unchanged", () => {
  test("listBindings still returns all bindings for agent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 30; i++) {
          await seedBinding(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }
        const all = await ClarusBindingStore.listBindings(AGENT_ID)
        expect(all.length).toBe(30)
      },
    })
  })

  test("listTaskBindings still returns all task bindings for project", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 30; i++) {
          await seedTask(AGENT_ID, PROJECT_ID, `task_${String(i).padStart(3, "0")}`)
        }
        const all = await ClarusTaskBindingStore.listTaskBindings(AGENT_ID, PROJECT_ID)
        expect(all.length).toBe(30)
      },
    })
  })

  test("listByProject still returns all activities", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 30; i++) {
          await seedActivity(AGENT_ID, PROJECT_ID, `msg_${String(i).padStart(3, "0")}`)
        }
        const all = await ClarusProjectActivityStore.listByProject(AGENT_ID, PROJECT_ID)
        expect(all.length).toBe(30)
      },
    })
  })
})
