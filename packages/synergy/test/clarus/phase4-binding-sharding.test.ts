import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusProjectBindingV3Schema, ClarusTaskBindingV4Schema } from "../../src/clarus/schemas"
import type { ClarusProjectBindingV3, ClarusTaskBindingV4 } from "../../src/clarus/schemas"
import { encodeSegment } from "../../src/clarus/keys"

let AGENT_ID = "agent_s"
let AGENT_ID_B = "agent_sb"
let PROJECT_ID = "project_s"

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `ag_${suffix}`
  AGENT_ID_B = `agb_${suffix}`
  PROJECT_ID = `pj_${suffix}`
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

// ─────────────────────────────────────────────────────────────────
// 1. Fresh canonical writes/reads
// ─────────────────────────────────────────────────────────────────
describe("canonical sharded project bindings", () => {
  test("ensureActive writes to agent-scoped canonical path", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        expect(binding.agentId).toBe(AGENT_ID)
        expect(binding.projectId).toBe(PROJECT_ID)

        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)
        const raw = await Storage.read<unknown>(canonicalPath)
        expect(raw).toBeDefined()

        const flatPath = StoragePath.clarusBinding(`${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`)
        const flatRaw = await Storage.read<unknown>(flatPath).catch(() => undefined)
        expect(flatRaw).toBeUndefined()
      },
    })
  })

  test("readV3 reads from sharded path after ensureActive", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        const binding = await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID)
        expect(binding).toBeDefined()
        expect(binding!.lifecycle).toBe("active")
      },
    })
  })

  test("isActive returns true after ensureActive", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        const active = await ClarusBindingStore.isActive(AGENT_ID, PROJECT_ID)
        expect(active).toBe(true)
      },
    })
  })

  test("setInactive writes inactive binding to sharded path", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.setInactive(AGENT_ID, PROJECT_ID)
        const binding = await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID)
        expect(binding).toBeDefined()
        expect(binding!.lifecycle).toBe("archived")
      },
    })
  })

  test("reconcileBinding writes to sharded path", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const result = await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Test Project",
          projectStatus: "active",
        })
        expect(result.projectName).toBe("Test Project")

        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)
        const raw = await Storage.read<unknown>(canonicalPath).catch(() => undefined)
        expect(raw).toBeDefined()
      },
    })
  })

  test("listBindings enumerates agent's shard directory only", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_a`)
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_b`)
        await ClarusBindingStore.ensureActive(AGENT_ID_B, "other_project")

        const results = await ClarusBindingStore.listBindings(AGENT_ID)
        const projectIds = results.map((b) => b.projectId)
        expect(projectIds).toContain(`${PROJECT_ID}_a`)
        expect(projectIds).toContain(`${PROJECT_ID}_b`)
        expect(projectIds).not.toContain("other_project")
        expect(results).toHaveLength(2)
      },
    })
  })

  test("listBindingsBounded scans agent directory — proves no cross-agent enumeration", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_a`)
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_b`)
        await ClarusBindingStore.ensureActive(AGENT_ID_B, "other_a")
        await ClarusBindingStore.ensureActive(AGENT_ID_B, "other_b")

        const page = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 50 })
        const projectIds = page.items.map((b) => b.projectId)
        expect(projectIds).toContain(`${PROJECT_ID}_a`)
        expect(projectIds).toContain(`${PROJECT_ID}_b`)
        expect(projectIds).not.toContain("other_a")
        expect(projectIds).not.toContain("other_b")
        expect(page.items.length).toBe(2)

        const agentBRoot = StoragePath.clarusAgentProjectRoot(AGENT_ID_B)
        const agentBKeys = await Storage.scan(agentBRoot)
        expect(agentBKeys.length).toBeGreaterThanOrEqual(2)
        const hasAgentAKeys = agentBKeys.some((k) => k.includes(encodeSegment(PROJECT_ID)))
        expect(hasAgentAKeys).toBe(false)
      },
    })
  })

  test("bounded listing pagination works with sharded layout", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 25
        for (let i = 0; i < count; i++) {
          await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_${String(i).padStart(3, "0")}`)
        }

        const page1 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10 })
        expect(page1.items.length).toBeLessThanOrEqual(10)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10, cursor: page1.nextCursor! })
        expect(page2.items.length).toBeLessThanOrEqual(10)

        const ids1 = new Set(page1.items.map((b) => b.projectId))
        const ids2 = new Set(page2.items.map((b) => b.projectId))
        for (const id of ids2) expect(ids1.has(id)).toBe(false)

        const page3 = await ClarusBindingStore.listBindingsBounded(AGENT_ID, { limit: 10, cursor: page2.nextCursor! })
        const allIds = new Set([
          ...page1.items.map((b) => b.projectId),
          ...page2.items.map((b) => b.projectId),
          ...page3.items.map((b) => b.projectId),
        ])
        expect(allIds.size).toBe(count)
      },
    })
  })
})

describe("canonical sharded task bindings", () => {
  test("ensureAssigned writes to agent/project-scoped canonical path", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "task_001",
          "ses_001",
          "/tmp/ws",
          "sc_001",
        )
        expect(binding.taskId).toBe("task_001")

        const canonicalPath = StoragePath.clarusShardTaskBinding(AGENT_ID, PROJECT_ID, "task_001")
        const raw = await Storage.read<unknown>(canonicalPath)
        expect(raw).toBeDefined()
      },
    })
  })

  test("project-scoped task listing scans only the project directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_a", "ses_a", "/tmp/ws", "sc_a")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_b", "ses_b", "/tmp/ws", "sc_b")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_y`, "task_y", "ses_y", "/tmp/ws", "sc_y")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          projectId: PROJECT_ID,
          limit: 50,
        })
        const taskIds = page.items.map((t) => t.taskId)
        expect(taskIds).toContain("task_a")
        expect(taskIds).toContain("task_b")
        expect(taskIds).not.toContain("task_y")
        expect(page.items.length).toBe(2)

        const projectRoot = StoragePath.clarusProjectTaskRoot(AGENT_ID, PROJECT_ID)
        const scanned = await Storage.scan(projectRoot)
        expect(scanned.length).toBe(2)
      },
    })
  })

  test("agent-scoped task listing enumerates across projects, bounded to agent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_x`, "task_x", "ses_x", "/tmp/ws", "sc_x")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_y`, "task_y", "ses_y", "/tmp/ws", "sc_y")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID_B, "other_proj", "task_other", "ses_o", "/tmp/ws", "sc_o")

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, { limit: 50 })
        const taskIds = page.items.map((t) => t.taskId)
        expect(taskIds).toContain("task_x")
        expect(taskIds).toContain("task_y")
        expect(taskIds).not.toContain("task_other")
        expect(page.items.length).toBe(2)
      },
    })
  })

  test("agent-scoped task listing paginates correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 15
        for (let i = 0; i < count; i++) {
          await ClarusTaskBindingStore.ensureAssigned(
            AGENT_ID,
            `${PROJECT_ID}_${i % 3}`,
            `task_${String(i).padStart(3, "0")}`,
            `ses_${i}`,
            "/tmp/ws",
            `sc_${i}`,
          )
        }

        const page1 = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, { limit: 5 })
        expect(page1.items.length).toBeLessThanOrEqual(5)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusTaskBindingStore.listTaskBindingsBounded(AGENT_ID, {
          limit: 5,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBeLessThanOrEqual(5)

        const ids1 = new Set(page1.items.map((t) => t.taskId))
        const ids2 = new Set(page2.items.map((t) => t.taskId))
        for (const id of ids2) expect(ids1.has(id)).toBe(false)
      },
    })
  })

  test("ownership and completion work with sharded paths", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const taskId = "task_own"
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, taskId, "ses_own", "/tmp/ws", "sc_own")

        const claimed = await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId,
          claimedByScopeID: "scope_own",
        })
        expect(claimed.taskSessionOwnershipClaim).toBeDefined()
        expect(claimed.taskSessionOwnershipClaim!.claimedByScopeID).toBe("scope_own")

        const resolved = await ClarusTaskBindingStore.resolveOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId,
        })
        expect(resolved.taskSessionOwnershipClaim!.resolvedAt).toBeGreaterThan(0)

        const completed = await ClarusTaskBindingStore.markCompleted({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId,
        })
        expect(completed).toBeDefined()
        expect(completed!.status).toBe("submitted")

        const canonicalPath = StoragePath.clarusShardTaskBinding(AGENT_ID, PROJECT_ID, taskId)
        const raw = await Storage.read<unknown>(canonicalPath)
        expect(raw).toBeDefined()
        const parsed = ClarusTaskBindingV4Schema.safeParse(raw)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
          expect(parsed.data.status).toBe("submitted")
        }
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 2. Legacy migration
// ─────────────────────────────────────────────────────────────────
describe("legacy binding shard migration", () => {
  test("migrates project bindings from flat to sharded", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeBinding(AGENT_ID, PROJECT_ID, { projectName: "Legacy Project" })
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        const legacyPath = StoragePath.clarusBinding(legacyKey)
        await Storage.write(legacyPath, binding)

        expect(await Storage.read<unknown>(legacyPath).catch(() => undefined)).toBeDefined()
        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)
        expect(await Storage.read<unknown>(canonicalPath).catch(() => undefined)).toBeUndefined()

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        expect(stats.projectMigrated).toBeGreaterThanOrEqual(1)
        expect(stats.projectCollisions).toBe(0)
        expect(stats.projectMalformed).toBe(0)

        expect(await Storage.read<unknown>(legacyPath).catch(() => undefined)).toBeUndefined()
        const canonical = await Storage.read<unknown>(canonicalPath)
        expect(canonical).toBeDefined()
        const parsed = ClarusProjectBindingV3Schema.safeParse(canonical)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
          expect(parsed.data.projectName).toBe("Legacy Project")
        }
      },
    })
  })

  test("migrates task bindings from flat to sharded", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeTaskBinding(AGENT_ID, PROJECT_ID, "task_legacy")
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}:${encodeSegment("task_legacy")}`
        const legacyPath = StoragePath.clarusTaskBinding(legacyKey)
        await Storage.write(legacyPath, binding)

        expect(await Storage.read<unknown>(legacyPath).catch(() => undefined)).toBeDefined()
        const canonicalPath = StoragePath.clarusShardTaskBinding(AGENT_ID, PROJECT_ID, "task_legacy")
        expect(await Storage.read<unknown>(canonicalPath).catch(() => undefined)).toBeUndefined()

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        expect(stats.taskMigrated).toBeGreaterThanOrEqual(1)
        expect(stats.taskCollisions).toBe(0)
        expect(stats.taskMalformed).toBe(0)

        expect(await Storage.read<unknown>(legacyPath).catch(() => undefined)).toBeUndefined()
        expect(await Storage.read<unknown>(canonicalPath)).toBeDefined()
      },
    })
  })

  test("repeated migration is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeBinding(AGENT_ID, PROJECT_ID)
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")

        const stats1 = await migrateBindingSharding()
        expect(stats1.projectMigrated).toBeGreaterThanOrEqual(1)

        const stats2 = await migrateBindingSharding()
        expect(stats2.projectMigrated).toBe(0)
        expect(stats2.projectCollisions).toBe(0)

        const canonical = await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))
        expect(canonical).toBeDefined()
      },
    })
  })

  test("already-migrated records are idempotent (skip+cleanup)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeBinding(AGENT_ID, PROJECT_ID)
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)

        await Storage.write(canonicalPath, binding)
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        expect(stats.projectSkipped).toBeGreaterThanOrEqual(1)
        expect(stats.projectMigrated).toBe(0)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)).toBeUndefined()
        expect(await Storage.read<unknown>(canonicalPath)).toBeDefined()
      },
    })
  })

  test("cross-identity non-V3 canonical blob is overwritten by migration", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Write a non-binding blob at the canonical path
        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)
        await Storage.write(canonicalPath, { notABinding: true })

        const binding = makeBinding(AGENT_ID, PROJECT_ID)
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        // Non-V3 existing blob at canonical → migration treats as no canonical, writes + deletes legacy
        expect(stats.projectMigrated).toBeGreaterThanOrEqual(1)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)).toBeUndefined()
      },
    })
  })

  test("malformed legacy source preserved and not migrated", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), { garbage: true })

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        expect(stats.projectMalformed).toBeGreaterThanOrEqual(1)
        expect(stats.projectMigrated).toBe(0)

        // Legacy should still be preserved (not deleted)
        const legacy = await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)
        expect(legacy).toBeDefined()
      },
    })
  })

  test("same-identity different-content canonical → collision not skip", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const bindingLegacy = makeBinding(AGENT_ID, PROJECT_ID, { projectName: "Legacy" })
        const bindingCanonical = makeBinding(AGENT_ID, PROJECT_ID, { projectName: "Existing" })
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        const canonicalPath = StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID)

        await Storage.write(canonicalPath, bindingCanonical)
        await Storage.write(StoragePath.clarusBinding(legacyKey), bindingLegacy)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        // Different content with same identity → collision, not skip
        expect(stats.projectCollisions).toBeGreaterThanOrEqual(1)
        expect(stats.projectSkipped).toBe(0)
        expect(stats.projectMigrated).toBe(0)

        // Legacy preserved (not deleted for collision)
        const legacy = await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)
        expect(legacy).toBeDefined()

        // Canonical unchanged
        const canonical = await Storage.read<unknown>(canonicalPath)
        const parsed = ClarusProjectBindingV3Schema.safeParse(canonical)
        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.projectName).toBe("Existing")
      },
    })
  })

  test("task same-identity different-content canonical → collision not skip", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const taskId = "task_collision"
        const bindingLegacy = makeTaskBinding(AGENT_ID, PROJECT_ID, taskId, { title: "Legacy" })
        const bindingCanonical = makeTaskBinding(AGENT_ID, PROJECT_ID, taskId, { title: "Existing" })
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}:${encodeSegment(taskId)}`
        const canonicalPath = StoragePath.clarusShardTaskBinding(AGENT_ID, PROJECT_ID, taskId)

        await Storage.write(canonicalPath, bindingCanonical)
        await Storage.write(StoragePath.clarusTaskBinding(legacyKey), bindingLegacy)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        expect(stats.taskCollisions).toBeGreaterThanOrEqual(1)
        expect(stats.taskSkipped).toBe(0)
        expect(stats.taskMigrated).toBe(0)

        const legacy = await Storage.read<unknown>(StoragePath.clarusTaskBinding(legacyKey)).catch(() => undefined)
        expect(legacy).toBeDefined()
      },
    })
  })

  test("migration handles empty flat directories gracefully", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        // On empty directories with unique IDs, no records should be migrated.
        // Shared data dir may have leftover entries from other tests.
        expect(stats.projectMigrated).toBe(0)
        expect(stats.taskMigrated).toBe(0)
      },
    })
  })

  test("canonical paths survive crash-then-reread after migration", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeBinding(AGENT_ID, PROJECT_ID, { projectName: "Survivor" })
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        await migrateBindingSharding()

        const result = await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID)
        expect(result).toBeDefined()
        expect(result!.projectName).toBe("Survivor")
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 3. Filesystem isolation proofs
// ─────────────────────────────────────────────────────────────────
describe("filesystem directory isolation", () => {
  test("Storage.scan on agent project root returns only that agent's projects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_1`)
        await ClarusBindingStore.ensureActive(AGENT_ID, `${PROJECT_ID}_2`)
        await ClarusBindingStore.ensureActive(AGENT_ID_B, "other_proj")

        const agentARoot = StoragePath.clarusAgentProjectRoot(AGENT_ID)
        const agentAKeys = await Storage.scan(agentARoot)
        expect(agentAKeys.length).toBeGreaterThanOrEqual(2)
        const encodedOther = encodeSegment("other_proj")
        expect(agentAKeys).not.toContain(encodedOther)

        const agentBRoot = StoragePath.clarusAgentProjectRoot(AGENT_ID_B)
        const agentBKeys = await Storage.scan(agentBRoot)
        expect(agentBKeys).toContain(encodedOther)
        const encodedA1 = encodeSegment(`${PROJECT_ID}_1`)
        expect(agentBKeys).not.toContain(encodedA1)
      },
    })
  })

  test("Storage.scan on project task root returns only that project's tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_a`, "task_1", "s1", "/ws", "sc1")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_a`, "task_2", "s2", "/ws", "sc2")
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, `${PROJECT_ID}_b`, "task_3", "s3", "/ws", "sc3")

        const projectARoot = StoragePath.clarusProjectTaskRoot(AGENT_ID, `${PROJECT_ID}_a`)
        const projectAKeys = await Storage.scan(projectARoot)
        expect(projectAKeys.length).toBe(2)
        expect(projectAKeys).not.toContain(encodeSegment("task_3"))
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 4. Integration with existing full migration (Phase 3 → Phase 4)
// ─────────────────────────────────────────────────────────────────
describe("integrated migration path", () => {
  test("clarusMigrations includes v4-forward, binding-sharding, and activity-timeline-index with dependsOn", () => {
    const { clarusMigrations } = require("../../src/clarus/migration") as {
      clarusMigrations: Array<{ id: string; dependsOn?: string[] }>
    }
    expect(clarusMigrations).toHaveLength(3)
    expect(clarusMigrations[0].id).toBe("20260715-clarus-v4-forward")
    expect(clarusMigrations[0].dependsOn).toBeUndefined()
    expect(clarusMigrations[1].id).toBe("20260715-clarus-binding-sharding")
    expect(clarusMigrations[1].dependsOn).toEqual(["20260715-clarus-v4-forward"])
    expect(clarusMigrations[2].id).toBe("20260715-clarus-activity-timeline-index")
    expect(clarusMigrations[2].dependsOn).toEqual(["20260715-clarus-binding-sharding"])
  })
})
