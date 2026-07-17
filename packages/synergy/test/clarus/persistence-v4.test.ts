import { test, expect, describe } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { ConfigDomain } from "../../src/config/domain"
import * as ConfigSchema from "../../src/config/schema"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import {
  ClarusProjectBindingV3Schema,
  ClarusTaskBindingV4Schema,
  ClarusOutboxRecordV2,
  ClarusOutboxRecordV1,
  ClarusOutboxStateV2,
  ClarusBindingV1Schema,
  ClarusBindingV2Schema,
  ClarusTaskBindingV1Schema,
  ClarusTaskBindingV2Schema,
  ClarusTaskBindingV3Schema,
  upgradeBindingV1ToV3,
  upgradeBindingV2ToV3,
  upgradeTaskBindingV1ToV4,
  upgradeTaskBindingV2ToV4,
  upgradeTaskBindingV3ToV4,
  upgradeOutboxV1ToV2,
} from "../../src/clarus/schemas"
import { encodeSegment, validateSegment, bindingKey, deriveAssignmentIDs, payloadHash } from "../../src/clarus/keys"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations } from "../../src/migration"

import "../../src/clarus/migration"

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

describe("Clarus config domain", () => {
  test("clarus domain exists between holos and email with correct ownership", () => {
    const domain = ConfigDomain.byId.get("clarus")
    expect(domain).toBeDefined()
    expect(domain!.filename).toBe("105-clarus.jsonc")
    expect(domain!.ownedKeys).toEqual(["clarus"])

    const ids = ConfigDomain.definitions.map((d) => d.id)
    const holosIdx = ids.indexOf("holos")
    const clarusIdx = ids.indexOf("clarus")
    const emailIdx = ids.indexOf("email")
    expect(holosIdx).toBeLessThan(clarusIdx)
    expect(clarusIdx).toBeLessThan(emailIdx)
  })

  test("clarus config schema has correct shape", () => {
    const clarusShape = ConfigSchema.ClarusConfig.shape
    expect(clarusShape.enabled).toBeDefined()
    expect(clarusShape.workspaceRoot).toBeDefined()
  })

  test("clarus is in Info schema", () => {
    const infoShape = ConfigSchema.Info.shape
    expect(infoShape.clarus).toBeDefined()
  })

  test("config domain registry is complete", () => {
    expect(() => ConfigDomain.assertRegistryComplete()).not.toThrow()
  })

  test("domainForKey resolves clarus", () => {
    const domain = ConfigDomain.domainForKey("clarus")
    expect(domain).toBeDefined()
    expect(domain!.id).toBe("clarus")
  })
})

describe("Clarus keys", () => {
  test("encodeSegment encodes special characters", () => {
    const result = encodeSegment("hello world/<>")
    expect(result).not.toContain(":")
    expect(result).not.toContain("/")
  })

  test("validateSegment passes for valid segments", () => {
    expect(validateSegment("agent-1")).toBe("agent-1")
    expect(validateSegment("a".repeat(512))).toHaveLength(512)
  })

  test("validateSegment throws for empty", () => {
    expect(() => validateSegment("")).toThrow("must not be empty")
  })

  test("validateSegment throws for too long", () => {
    expect(() => validateSegment("a".repeat(513))).toThrow("exceeds max length")
  })

  test("bindingKey produces deterministic output", () => {
    const k1 = bindingKey("agent-a", "project-1")
    const k2 = bindingKey("agent-a", "project-1")
    expect(k1).toBe(k2)
  })

  test("bindingKey is collision-safe", () => {
    const k1 = bindingKey("a", "b:c")
    const k2 = bindingKey("a:b", "c")
    expect(k1).not.toBe(k2)
  })

  test("deriveAssignmentIDs produces stable IDs", () => {
    const v1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const v2 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    expect(v1.itemID).toBe(v2.itemID)
    expect(v1.messageID).toBe(v2.messageID)
    expect(v1.itemID).toMatch(/^inb_clarus_/)
    expect(v1.messageID).toMatch(/^msg_clarus_/)
  })

  test("deriveAssignmentIDs produces unique IDs for different tasks", () => {
    const v1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const v2 = deriveAssignmentIDs("agent-a", "project-1", "task-2")
    expect(v1.itemID).not.toBe(v2.itemID)
  })

  test("payloadHash is deterministic with key ordering", () => {
    const h1 = payloadHash({ a: 1, b: 2 })
    const h2 = payloadHash({ b: 2, a: 1 })
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(32)
  })

  test("payloadHash differs for different content", () => {
    const h1 = payloadHash({ a: 1 })
    const h2 = payloadHash({ a: 2 })
    expect(h1).not.toBe(h2)
  })
})

describe("Clarus schemas", () => {
  test("ClarusProjectBindingV3Schema validates correct V3 binding", () => {
    const result = ClarusProjectBindingV3Schema.safeParse({
      schemaVersion: 3,
      agentId: "agent-1",
      projectId: "project-1",
      lifecycle: "active",
      desiredSubscription: true,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(result.success).toBe(true)
  })

  test("ClarusProjectBindingV3Schema rejects extra fields", () => {
    const result = ClarusProjectBindingV3Schema.safeParse({
      schemaVersion: 3,
      agentId: "agent-1",
      projectId: "project-1",
      lifecycle: "active",
      desiredSubscription: true,
      projectSessionID: "old-field",
      createdAt: 0,
      updatedAt: 0,
    })
    expect(result.success).toBe(false)
  })

  test("ClarusTaskBindingV4Schema validates correct V4 binding", () => {
    const result = ClarusTaskBindingV4Schema.safeParse({
      schemaVersion: 4,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses_test",
      workspacePath: "/tmp/ws",
      scopeID: "scope_test",
      runID: "",
      subtaskID: "",
      phase: "",
      attempt: 0,
      title: "Test task",
      taskInput: {},
      contextHydration: "unavailable" as const,
      frozenAgent: "",
      assignmentState: "planned" as const,
      assignmentInboxItemID: "inb_test",
      assignmentMessageID: "msg_test",
      status: "waiting" as const,
      resultState: "idle" as const,
      extendOutboxRequestIDs: [],
      createdAt: 0,
      updatedAt: 0,
    })
    expect(result.success).toBe(true)
  })

  test("ClarusTaskBindingV4Schema rejects missing required fields", () => {
    const result = ClarusTaskBindingV4Schema.safeParse({
      schemaVersion: 4,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
    })
    expect(result.success).toBe(false)
  })

  test("ClarusOutboxRecordV2 validates correct V2 record", () => {
    const result = ClarusOutboxRecordV2.safeParse({
      schemaVersion: 2,
      requestID: "req-1",
      action: "task_result",
      agentId: "agent-1",
      projectId: "project-1",
      payload: {},
      payloadHash: "abc123",
      state: "prepared" as ClarusOutboxStateV2,
      preparedAt: 0,
    })
    expect(result.success).toBe(true)
  })

  test("ClarusOutboxRecordV2 rejects invalid state", () => {
    const result = ClarusOutboxRecordV2.safeParse({
      schemaVersion: 2,
      requestID: "req-1",
      action: "task_result",
      agentId: "agent-1",
      projectId: "project-1",
      payload: {},
      payloadHash: "abc123",
      state: "pending",
      preparedAt: 0,
    })
    expect(result.success).toBe(false)
  })

  test("outbox state V2 has correct states and no legacy states", () => {
    const stateField = ClarusOutboxRecordV2.shape.state
    expect(stateField.options).toContain("prepared")
    expect(stateField.options).toContain("dispatched")
    expect(stateField.options).toContain("acknowledged")
    expect(stateField.options).toContain("rejected")
    expect(stateField.options).toContain("ambiguous")
    expect(stateField.options).not.toContain("pending")
    expect(stateField.options).not.toContain("sent")
  })
})

describe("Clarus upgrade functions", () => {
  test("upgradeBindingV1ToV3 converts correctly", () => {
    const v1 = ClarusBindingV1Schema.parse({
      schemaVersion: 1,
      agentId: "agent-1",
      projectId: "project-1",
      state: "active",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      projectSessionID: "ses-1",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v3 = upgradeBindingV1ToV3(v1)
    expect(v3.schemaVersion).toBe(3)
    expect(v3.lifecycle).toBe("active")
    expect(v3.desiredSubscription).toBe(true)
    expect(v3.messageCursor).toBeNull()
  })

  test("upgradeBindingV1ToV3 maps inactive to archived", () => {
    const v1 = ClarusBindingV1Schema.parse({
      schemaVersion: 1,
      agentId: "agent-2",
      projectId: "project-2",
      state: "inactive",
      workspacePath: "/tmp",
      scopeID: "scope-2",
      projectSessionID: "ses-2",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v3 = upgradeBindingV1ToV3(v1)
    expect(v3.lifecycle).toBe("archived")
    expect(v3.desiredSubscription).toBe(false)
  })

  test("upgradeBindingV2ToV3 preserves optional fields", () => {
    const v2 = ClarusBindingV2Schema.parse({
      schemaVersion: 2,
      agentId: "agent-3",
      projectId: "project-3",
      lifecycle: "active",
      workspacePath: "/tmp",
      scopeID: "scope-3",
      projectSessionID: "ses-3",
      projectName: "My Project",
      projectSlug: "my-project",
      projectStatus: "in_progress",
      desiredSubscription: true,
      messageCursor: "cursor-1",
      lastReconciliationAt: 3000,
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v3 = upgradeBindingV2ToV3(v2)
    expect(v3.projectName).toBe("My Project")
    expect(v3.projectStatus).toBe("in_progress")
    expect(v3.messageCursor).toBe("cursor-1")
    expect(v3.lastReconciliationAt).toBe(3000)
  })

  test("upgradeTaskBindingV1ToV4 sets defaults", () => {
    const v1 = ClarusTaskBindingV1Schema.parse({
      schemaVersion: 1,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses-1",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      status: "assigned",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v4 = upgradeTaskBindingV1ToV4(v1)
    expect(v4.schemaVersion).toBe(4)
    expect(v4.assignmentState).toBe("planned")
    expect(v4.status).toBe("waiting")
    expect(v4.resultState).toBe("idle")
  })

  test("upgradeTaskBindingV1ToV4 preserves optional assignment IDs", () => {
    const v1 = ClarusTaskBindingV1Schema.parse({
      schemaVersion: 1,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses-1",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      status: "assigned",
      assignmentInboxItemID: "inb-1",
      assignmentMessageID: "msg-1",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v4 = upgradeTaskBindingV1ToV4(v1)
    expect(v4.assignmentInboxItemID).toBe("inb-1")
    expect(v4.assignmentMessageID).toBe("msg-1")
  })

  test("upgradeTaskBindingV2ToV4 maps completed with result to submitted", () => {
    const v2 = ClarusTaskBindingV2Schema.parse({
      schemaVersion: 2,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses-1",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      status: "completed",
      resultOutboxRequestID: "out-1",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v4 = upgradeTaskBindingV2ToV4(v2)
    expect(v4.status).toBe("submitted")
  })

  test("upgradeTaskBindingV2ToV4 maps completed without result to needs_attention", () => {
    const v2 = ClarusTaskBindingV2Schema.parse({
      schemaVersion: 2,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses-1",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      status: "completed",
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v4 = upgradeTaskBindingV2ToV4(v2)
    expect(v4.status).toBe("needs_attention")
  })

  test("upgradeTaskBindingV3ToV4 preserves fields and sets resultState idle", () => {
    const v3 = ClarusTaskBindingV3Schema.parse({
      schemaVersion: 3,
      agentId: "ag-1",
      projectId: "pr-1",
      taskId: "tk-1",
      sessionID: "ses-1",
      workspacePath: "/ws",
      scopeID: "sc-1",
      runID: "run-1",
      subtaskID: "sub-1",
      phase: "exec",
      attempt: 2,
      title: "My Task",
      taskInput: { goal: "test" },
      contextHydration: "complete",
      frozenAgent: "agent-x",
      assignmentState: "processing",
      assignmentInboxItemID: "inb-1",
      assignmentMessageID: "msg-1",
      status: "running",
      extendOutboxRequestIDs: ["ext-1"],
      createdAt: 1000,
      updatedAt: 2000,
    })
    const v4 = upgradeTaskBindingV3ToV4(v3)
    expect(v4.schemaVersion).toBe(4)
    expect(v4.title).toBe("My Task")
    expect(v4.runID).toBe("run-1")
    expect(v4.status).toBe("running")
    expect(v4.resultState).toBe("idle")
    expect(v4.extendOutboxRequestIDs).toEqual(["ext-1"])
  })

  test("upgradeOutboxV1ToV2 maps all states correctly", () => {
    const v1 = ClarusOutboxRecordV1.parse({
      schemaVersion: 1,
      requestID: "req-1",
      action: "task_result",
      agentId: "ag-1",
      projectId: "pr-1",
      state: "pending",
      createdAt: 1000,
      updatedAt: 1000,
    })
    const v2 = upgradeOutboxV1ToV2(v1)
    expect(v2.schemaVersion).toBe(2)
    expect(v2.state).toBe("prepared")
    expect(v2.connectionEpoch).toBeUndefined()
  })

  test("upgradeOutboxV1ToV2 uses the runtime canonical payload hash", () => {
    const v1 = ClarusOutboxRecordV1.parse({
      schemaVersion: 1,
      requestID: "req-hash",
      action: "task_result",
      agentId: "ag-1",
      projectId: "pr-1",
      payload: { result: { content: "done", metadata: { z: 1, a: 2 } } },
      state: "acknowledged",
      resolvedAt: 2000,
      resolvedBy: "sys",
      createdAt: 1000,
      updatedAt: 1000,
    })
    const v2 = upgradeOutboxV1ToV2(v1)
    expect(v2.state).toBe("acknowledged")
    expect(v2.acknowledgedAt).toBe(2000)
    expect(v2.payloadHash).toBe(payloadHash(v1.payload!))
  })
})

describe("Clarus persistence (fresh state)", () => {
  test("fresh Project V3 can be persisted and read", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const binding = {
            schemaVersion: 3 as const,
            agentId: "agent-test",
            projectId: "project-test",
            lifecycle: "active" as const,
            desiredSubscription: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          const key = bindingKey("agent-test", "project-test")
          await Storage.write(StoragePath.clarusBinding(key), binding)

          const read = await Storage.read<unknown>(StoragePath.clarusBinding(key))
          const parsed = ClarusProjectBindingV3Schema.safeParse(read)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.schemaVersion).toBe(3)
            expect(parsed.data.agentId).toBe("agent-test")
          }
        })(),
    })
  })

  test("fresh Task V4 can be persisted and read", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const binding = {
            schemaVersion: 4 as const,
            agentId: "agent-test",
            projectId: "pr-test",
            taskId: "tk-test",
            sessionID: "ses-1",
            workspacePath: "/tmp/ws",
            scopeID: scope.id,
            runID: "",
            subtaskID: "",
            phase: "",
            attempt: 0,
            title: "Test Task",
            taskInput: {},
            contextHydration: "unavailable" as const,
            frozenAgent: "",
            assignmentState: "planned" as const,
            assignmentInboxItemID: "inb-1",
            assignmentMessageID: "msg-1",
            status: "waiting" as const,
            resultState: "idle" as const,
            extendOutboxRequestIDs: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }

          const tkey = `${encodeURIComponent("agent-test")}:${encodeURIComponent("pr-test")}:${encodeURIComponent("tk-test")}`
          await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], binding)

          const read = await Storage.read<unknown>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
          const parsed = ClarusTaskBindingV4Schema.safeParse(read)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.schemaVersion).toBe(4)
            expect(parsed.data.title).toBe("Test Task")
            expect(parsed.data.resultState).toBe("idle")
          }
        })(),
    })
  })

  test("fresh Outbox V2 can be persisted and read", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = {
            schemaVersion: 2 as const,
            requestID: "req-test",
            action: "task_result" as const,
            agentId: "ag-1",
            projectId: "pr-1",
            taskId: "tk-1",
            payload: { result: "done" },
            payloadHash: payloadHash({ result: "done" }),
            state: "prepared" as ClarusOutboxStateV2,
            connectionEpoch: "epoch-1",
            preparedAt: Date.now(),
          }
          await Storage.write(StoragePath.clarusOutbox("req-test"), record)

          const read = await Storage.read<unknown>(StoragePath.clarusOutbox("req-test"))
          const parsed = ClarusOutboxRecordV2.safeParse(read)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.state).toBe("prepared")
            expect(parsed.data.connectionEpoch).toBe("epoch-1")
            expect(parsed.data.payloadHash).toBe(payloadHash({ result: "done" }))
          }
        })(),
    })
  })

  test("reverse index can be co-written and read back", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const sessionID = "ses-rev-test"
          const agentId = "ag-rev"
          const projectId = "pr-rev"
          const taskId = "tk-rev"

          const entryKey = `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`
          await Storage.write(StoragePath.clarusSessionTaskIndex(sessionID), { [entryKey]: true })

          const index = await Storage.read<Record<string, unknown>>(StoragePath.clarusSessionTaskIndex(sessionID))
          expect(index).toBeDefined()
          expect(index[entryKey]).toBe(true)
        })(),
    })
  })
})

describe("Migration registration", () => {
  test("clarus migration is registered", () => {
    resetMigrations()
    const domains = MigrationRegistry.list()
    expect(domains.has("clarus")).toBe(true)

    const clarusMigrations = domains.get("clarus")!
    expect(clarusMigrations.length).toBeGreaterThanOrEqual(1)
    expect(clarusMigrations.some((m) => m.id === "20260715-clarus-v4-forward")).toBe(true)
  })
})

describe("Deterministic task enqueue invariants", () => {
  test("deriveAssignmentIDs returns stable IDs across calls", () => {
    const r1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const r2 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    expect(r1.itemID).toBe(r2.itemID)
    expect(r1.messageID).toBe(r2.messageID)
  })

  test("deriveAssignmentIDs differs by agent", () => {
    const r1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const r2 = deriveAssignmentIDs("agent-b", "project-1", "task-1")
    expect(r1.itemID).not.toBe(r2.itemID)
  })

  test("deriveAssignmentIDs differs by project", () => {
    const r1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const r2 = deriveAssignmentIDs("agent-a", "project-2", "task-1")
    expect(r1.itemID).not.toBe(r2.itemID)
  })

  test("deriveAssignmentIDs differs by task", () => {
    const r1 = deriveAssignmentIDs("agent-a", "project-1", "task-1")
    const r2 = deriveAssignmentIDs("agent-a", "project-1", "task-2")
    expect(r1.itemID).not.toBe(r2.itemID)
  })

  test("payloadHash is stable with key ordering", () => {
    const h1 = payloadHash({ z: "last", a: "first" })
    const h2 = payloadHash({ a: "first", z: "last" })
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(32)
  })

  test("payloadHash differs for different content", () => {
    const h1 = payloadHash({ key: "value1" })
    const h2 = payloadHash({ key: "value2" })
    expect(h1).not.toBe(h2)
  })
})
