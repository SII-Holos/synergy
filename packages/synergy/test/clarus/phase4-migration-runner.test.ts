import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { encodeSegment } from "../../src/clarus/keys"
import { MigrationRegistry } from "../../src/migration/registry"
import { orderMigrations } from "../../src/migration/order"

let AGENT_ID = "agent_r"
let AGENT_ID_B = "agent_rb"
let PROJECT_ID = "project_r"
let TASK_ID = "task_r"

function writeClarusLog(entries: Record<string, number>) {
  return Storage.write(StoragePath.metaMigrationLogDomain("clarus"), entries)
}

function clearClarusLog() {
  return Storage.remove(StoragePath.metaMigrationLogDomain("clarus")).catch(() => {})
}

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `agr_${suffix}`
  AGENT_ID_B = `agrb_${suffix}`
  PROJECT_ID = `pjr_${suffix}`
  TASK_ID = `tkr_${suffix}`
})

function makeV3Binding(agentId: string, projectId: string, overrides?: Record<string, unknown>) {
  return {
    schemaVersion: 3,
    agentId,
    projectId,
    lifecycle: "active",
    desiredSubscription: true,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

function makeV4TaskBinding(agentId: string, projectId: string, taskId: string, overrides?: Record<string, unknown>) {
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
    contextHydration: "unavailable" as const,
    frozenAgent: "",
    assignmentState: "planned" as const,
    assignmentInboxItemID: "",
    assignmentMessageID: "",
    status: "waiting" as const,
    resultState: "idle" as const,
    extendOutboxRequestIDs: [] as string[],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

function makeActivity(agentId: string, projectId: string, messageId: string, receivedAt: number) {
  return {
    agentId,
    projectId,
    messageId,
    senderType: "user",
    content: `msg_${messageId}`,
    receivedAt,
  }
}

const ACTIVITY_TS_PAD = 16
const ACTIVITY_SORT_SEP = "--"

function buildSortKey(receivedAt: number, messageId: string): string {
  return `${String(receivedAt).padStart(ACTIVITY_TS_PAD, "0")}${ACTIVITY_SORT_SEP}${encodeURIComponent(messageId)}`
}

// ─────────────────────────────────────────────────────────────────
// 1. Runner with mixed historical state
// ─────────────────────────────────────────────────────────────────
describe("migration runner with mixed historical state", () => {
  test("runs all three clarus migrations in order from mixed historical data", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await clearClarusLog()

        // ---- Setup: mixed historical state ----
        const pjBinding = makeV3Binding(AGENT_ID, PROJECT_ID, { projectName: "Historical Project" })
        const pjLegacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(pjLegacyKey), pjBinding)

        const taskBinding = makeV4TaskBinding(AGENT_ID, PROJECT_ID, TASK_ID)
        const taskLegacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}:${encodeSegment(TASK_ID)}`
        await Storage.write(StoragePath.clarusTaskBinding(taskLegacyKey), taskBinding)

        const outboxV1 = {
          schemaVersion: 1,
          requestID: "req_001",
          action: "project_message",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          payload: { content: "hello" },
          state: "sent",
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        }
        await Storage.write(StoragePath.clarusOutbox("req_001"), outboxV1)

        const activities = [
          makeActivity(AGENT_ID, PROJECT_ID, "act_1", 1000),
          makeActivity(AGENT_ID, PROJECT_ID, "act_2", 3000),
          makeActivity(AGENT_ID, PROJECT_ID, "act_3", 2000),
        ]
        for (const act of activities) {
          await Storage.write(StoragePath.clarusProjectActivity(act.agentId, act.projectId, act.messageId), act)
        }
        const runOrder: string[] = []
        let lastMigrationId = ""
        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()

        const summary = await runMigrations({
          targetDomain: "clarus",
          output: "silent",
          reporter: {
            summary: () => {},
            progress: (input) => {
              // Deduplicate by migration ID to track ordering
              if (input.migration.id !== lastMigrationId) {
                runOrder.push(input.migration.id)
                lastMigrationId = input.migration.id
              }
            },
          },
        })
        expect(runOrder[0]).toBe("20260715-clarus-v4-forward")
        expect(runOrder[1]).toBe("20260715-clarus-binding-sharding")
        expect(runOrder[2]).toBe("20260715-clarus-activity-timeline-index")
        expect(summary.completed).toBe(3)
        expect(summary.failed).toBe(0)

        // Outbox upgraded
        const outboxAfter = await Storage.read<Record<string, unknown>>(StoragePath.clarusOutbox("req_001"))
        expect(outboxAfter).toBeDefined()
        expect(outboxAfter!.schemaVersion).toBe(2)

        // Project binding: legacy deleted, canonical exists
        expect(
          await Storage.read<unknown>(StoragePath.clarusBinding(pjLegacyKey)).catch(() => undefined),
        ).toBeUndefined()
        const pjCanonical = await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))
        expect(pjCanonical).toBeDefined()
        expect((pjCanonical as Record<string, unknown>).projectName).toBe("Historical Project")

        // Task binding: legacy deleted, canonical exists
        expect(
          await Storage.read<unknown>(StoragePath.clarusTaskBinding(taskLegacyKey)).catch(() => undefined),
        ).toBeUndefined()
        expect(
          await Storage.read<unknown>(StoragePath.clarusShardTaskBinding(AGENT_ID, PROJECT_ID, TASK_ID)),
        ).toBeDefined()

        // Timeline index built
        const timelineKeys = await Storage.scan(StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID))
        expect(timelineKeys.length).toBe(3)
        expect(timelineKeys[0]).toBe(buildSortKey(1000, "act_1"))
        expect(timelineKeys[1]).toBe(buildSortKey(2000, "act_3"))
        expect(timelineKeys[2]).toBe(buildSortKey(3000, "act_2"))
      },
    })
  })

  test("idempotent second execution", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await clearClarusLog()

        const binding = makeV3Binding(AGENT_ID, PROJECT_ID)
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")

        resetMigrations()
        const summary1 = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary1.completed).toBe(3)
        expect(summary1.failed).toBe(0)

        resetMigrations()
        const summary2 = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary2.completed).toBe(0)
        expect(summary2.failed).toBe(0)
        expect(summary2.upToDateDomains).toBe(1)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)).toBeUndefined()
        expect(await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))).toBeDefined()
      },
    })
  })

  test("second agent data isolated and untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await clearClarusLog()

        await Storage.write(
          StoragePath.clarusBinding(`${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`),
          makeV3Binding(AGENT_ID, PROJECT_ID),
        )
        await Storage.write(
          StoragePath.clarusBinding(`${encodeSegment(AGENT_ID_B)}:${encodeSegment("other_proj")}`),
          makeV3Binding(AGENT_ID_B, "other_proj"),
        )

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(3)
        expect(summary.failed).toBe(0)

        expect(await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))).toBeDefined()
        expect(
          await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID_B, "other_proj")),
        ).toBeDefined()

        const agentAKeys = await Storage.scan(StoragePath.clarusAgentProjectRoot(AGENT_ID))
        expect(agentAKeys.length).toBe(1)
        expect(agentAKeys).toContain(encodeSegment(PROJECT_ID))
        expect(agentAKeys).not.toContain(encodeSegment("other_proj"))
      },
    })
  })

  test("progress restart — interrupted migration picks up where it left off", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await writeClarusLog({ "20260715-clarus-v4-forward": Date.now() })

        await Storage.write(
          StoragePath.clarusBinding(`${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`),
          makeV3Binding(AGENT_ID, PROJECT_ID),
        )
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "act_1"),
          makeActivity(AGENT_ID, PROJECT_ID, "act_1", 1000),
        )

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(2)
        expect(summary.failed).toBe(0)

        expect(
          await Storage.read<unknown>(
            StoragePath.clarusBinding(`${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`),
          ).catch(() => undefined),
        ).toBeUndefined()

        const timelineKeys = await Storage.scan(StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID))
        expect(timelineKeys.length).toBe(1)

        const updatedLog = await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("clarus"))
        expect(Object.keys(updatedLog!)).toContain("20260715-clarus-v4-forward")
        expect(Object.keys(updatedLog!)).toContain("20260715-clarus-binding-sharding")
        expect(Object.keys(updatedLog!)).toContain("20260715-clarus-activity-timeline-index")
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 2. Malformed and partial data preservation
// ─────────────────────────────────────────────────────────────────
describe("malformed data preservation during runner", () => {
  test("malformed legacy binding preserved after full migration run", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await clearClarusLog()

        const goodKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(goodKey), makeV3Binding(AGENT_ID, PROJECT_ID))

        const malformedKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID + "_bad")}`
        await Storage.write(StoragePath.clarusBinding(malformedKey), { garbage: true })

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(3)
        expect(summary.failed).toBe(0)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(goodKey)).catch(() => undefined)).toBeUndefined()
        expect(
          await Storage.read<unknown>(StoragePath.clarusBinding(malformedKey)).catch(() => undefined),
        ).toBeDefined()
      },
    })
  })

  test("malformed activity records preserved after timeline migration", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await writeClarusLog({
          "20260715-clarus-v4-forward": Date.now(),
          "20260715-clarus-binding-sharding": Date.now(),
        })

        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "act_good"),
          makeActivity(AGENT_ID, PROJECT_ID, "act_good", 1000),
        )
        await Storage.write(StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "act_bad"), { notAnActivity: true })

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(1)
        expect(summary.failed).toBe(0)

        const timelineKeys = await Storage.scan(StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID))
        expect(timelineKeys.length).toBe(1)
        expect(timelineKeys[0]).toBe(buildSortKey(1000, "act_good"))

        expect(
          await Storage.read<unknown>(StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "act_bad")).catch(
            () => undefined,
          ),
        ).toBeDefined()
      },
    })
  })

  test("preexisting canonical mismatch is treated as collision, not overwrite", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await writeClarusLog({ "20260715-clarus-v4-forward": Date.now() })

        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(
          StoragePath.clarusBinding(legacyKey),
          makeV3Binding(AGENT_ID, PROJECT_ID, { projectName: "Legacy" }),
        )
        await Storage.write(
          StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID),
          makeV3Binding(AGENT_ID, PROJECT_ID, { projectName: "Existing" }),
        )

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(2)
        expect(summary.failed).toBe(0)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)).toBeDefined()

        const canonical = await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))
        expect((canonical as Record<string, unknown>).projectName).toBe("Existing")
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 3. Phase-specific direct-call assertions
// ─────────────────────────────────────────────────────────────────
describe("phase-specific verification", () => {
  test("binding-sharding verifies readback parse + deep equality before deleting legacy", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = makeV3Binding(AGENT_ID, PROJECT_ID, { projectName: "Verify Me" })
        const legacyKey = `${encodeSegment(AGENT_ID)}:${encodeSegment(PROJECT_ID)}`
        await Storage.write(StoragePath.clarusBinding(legacyKey), binding)

        const { migrateBindingSharding } = await import("../../src/clarus/migration")
        const stats = await migrateBindingSharding()

        // projectMalformed may include entries from shared data dir
        expect(stats.projectMigrated).toBe(1)

        expect(await Storage.read<unknown>(StoragePath.clarusBinding(legacyKey)).catch(() => undefined)).toBeUndefined()

        const canonical = await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(AGENT_ID, PROJECT_ID))
        expect(canonical).toBeDefined()
        expect((canonical as Record<string, unknown>).projectName).toBe("Verify Me")
      },
    })
  })

  test("fresh install no-op: empty state runs all clarus migrations without error", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await clearClarusLog()

        const { runMigrations, resetMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const summary = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(summary.completed).toBe(3)
        expect(summary.failed).toBe(0)

        // Shared data dir may have entries from other tests;
        // the key invariants are: all 3 completed, none failed.
        const logAfter = await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("clarus"))
        expect(Object.keys(logAfter!)).toHaveLength(3)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 4. Dependency graph
// ─────────────────────────────────────────────────────────────────
describe("migration dependency graph", () => {
  test("orderMigrations applies dependsOn topological ordering", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { clarusMigrations } = await import("../../src/clarus/migration")

        const ordered = orderMigrations(clarusMigrations)
        expect(ordered).toHaveLength(3)
        expect(ordered[0].id).toBe("20260715-clarus-v4-forward")
        expect(ordered[1].id).toBe("20260715-clarus-binding-sharding")
        expect(ordered[1].dependsOn).toEqual(["20260715-clarus-v4-forward"])
        expect(ordered[2].id).toBe("20260715-clarus-activity-timeline-index")
        expect(ordered[2].dependsOn).toEqual(["20260715-clarus-binding-sharding"])

        const registry = MigrationRegistry.list()
        const clarusReg = registry.get("clarus")
        expect(clarusReg).toBeDefined()
        expect(clarusReg!.length).toBe(3)

        const bindingShard = clarusReg!.find((m) => m.id === "20260715-clarus-binding-sharding")
        expect(bindingShard).toBeDefined()
        expect(bindingShard!.dependsOn).toEqual(["20260715-clarus-v4-forward"])

        const activityTimeline = clarusReg!.find((m) => m.id === "20260715-clarus-activity-timeline-index")
        expect(activityTimeline).toBeDefined()
        expect(activityTimeline!.dependsOn).toEqual(["20260715-clarus-binding-sharding"])
      },
    })
  })
})
