import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusDeadlineAgenda } from "../../src/channel/provider/clarus/deadline-agenda"
import { ClarusDeadline } from "../../src/channel/provider/clarus/assignment-prompt"
import { ClarusProvider } from "../../src/channel/provider/clarus"
import type {
  RuntimeTaskAssignedEvent,
  RuntimeTaskExtendedEvent,
} from "../../src/channel/provider/clarus/agent-tunnel-port"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { AgendaStore, Agenda } from "../../src/agenda"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../fixture/fixture"

// Expected contract tests for Clarus deadline rescheduling via extension.
// Tests fail RED until:
//   - ClarusProvider handles runtimeTaskExtended events
//   - Extension updates assignment.deadlineAt
//   - Extension reschedules the SAME Agenda item ID (not recreate)
//   - Stale extension identity/request is ignored
//   - Extension does not interfere with result or result outbox delivery

// ── Fixtures ───────────────────────────────────────────────────────

function assignmentFixture(overrides: Partial<RuntimeTaskAssignedEvent> = {}): RuntimeTaskAssignedEvent {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "agent-fixture",
    requestID: crypto.randomUUID(),
    projectID: "project-fixture",
    runID: `run-${crypto.randomUUID()}`,
    taskID: `task-${crypto.randomUUID()}`,
    phase: "implementation",
    subtaskID: `subtask-${crypto.randomUUID()}`,
    attempt: 1,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    goal: "Implement the feature",
    instructions: "Use clean architecture",
    input: { files: ["src/a.ts"] },
    context: { lang: "TypeScript" },
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

function extendedTaskFixture(overrides: Partial<RuntimeTaskExtendedEvent> = {}): RuntimeTaskExtendedEvent {
  return {
    kind: "known",
    type: "runtimeTaskExtended",
    agentID: "agent-fixture",
    requestID: crypto.randomUUID(),
    projectID: "project-fixture",
    runID: "run-fixture",
    task: { taskID: "task-fixture", deadlineAt: new Date(Date.now() + 10_800_000).toISOString(), status: "running" },
    epoch: 2,
    generation: 2,
    ...overrides,
  }
}

async function setupProjectScope(accountId: string, projectID: string) {
  return Channel.ensureProjectScope({
    channelType: "clarus",
    accountId,
    externalProjectId: projectID,
    projectName: `Project ${projectID}`,
  })
}

async function dispatchAssignment(accountId: string, event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId })
  return ClarusAssignmentRuntime.dispatch({ host, accountId, event })
}
async function handleExtensionEvent(accountId: string, event: RuntimeTaskExtendedEvent): Promise<void> {
  const provider = new ClarusProvider()
  const handler = provider as unknown as {
    handleEvent(
      connection: { accountId: string; signal: AbortSignal; outboundRequests: Set<string> },
      event: RuntimeTaskExtendedEvent,
    ): Promise<void>
  }
  await handler.handleEvent(
    {
      accountId,
      signal: new AbortController().signal,
      outboundRequests: new Set(),
    },
    event,
  )
}

// =============================================================================
// 1. Deadline rescheduling via extension event
// =============================================================================

describe("Clarus deadline rescheduling via runtimeTaskExtended", () => {
  test("authoritative runtimeTaskExtended updates assignment deadline", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "reschedule-account"
        const projectID = "reschedule-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-reschedule",
          runID: "run-reschedule",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)
        const originalAssignment = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(originalAssignment).toBeDefined()
        expect(originalAssignment!.assignment.deadlineAt).toBeString()

        const expectedItemID = ClarusDeadlineAgenda.itemID({
          accountId,
          projectID,
          taskID: event.taskID,
        })
        const before = await AgendaStore.get(scope.id, expectedItemID)
        expect(before.state.nextRunAt).toBeNumber()

        const newDeadline = new Date(Date.now() + 10_800_000).toISOString()
        const extendedEvent = extendedTaskFixture({
          agentID: accountId,
          projectID,
          runID: event.runID,
          requestID: null,
          task: { taskID: event.taskID, deadlineAt: newDeadline, status: "running" },
        })
        await handleExtensionEvent(accountId, extendedEvent)

        const updated = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(updated?.assignment.deadlineAt).toBe(newDeadline)
        const after = await AgendaStore.get(scope.id, expectedItemID)
        expect(after.id).toBe(before.id)
        expect(after.status).toBe("active")
        expect(after.state.nextRunAt).toBeGreaterThan(before.state.nextRunAt!)
      },
    })
  })

  test("extension reschedules same deterministic Agenda item ID without recreating", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "same-agenda-account"
        const projectID = "same-agenda-project"
        const scope = await setupProjectScope(accountId, projectID)
        const taskID = "task-same-agenda"
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID,
          runID: "run-same-agenda",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)
        const sessionID = created.assignment.sessionID

        // The itemID is deterministic
        const itemID1 = ClarusDeadlineAgenda.itemID({ accountId, projectID, taskID })
        const itemID2 = ClarusDeadlineAgenda.itemID({ accountId, projectID, taskID })
        expect(itemID1).toBe(itemID2)

        // Verify exactly one deadline Agenda item exists
        const itemsBefore = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(itemsBefore).toHaveLength(1)
        expect(itemsBefore[0]!.id).toBe(itemID1)

        // Simulate extension: call sync with a later deadline
        const newDeadline = new Date(Date.now() + 10_800_000).toISOString()
        await ClarusDeadlineAgenda.sync({
          accountId,
          projectID,
          taskID,
          sessionID,
          deadlineAt: newDeadline,
          active: true,
        })

        // After rescheduling, there should still be exactly ONE deadline Agenda item
        // with the same ID (not a new one)
        const itemsAfter = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(itemsAfter).toHaveLength(1)
        expect(itemsAfter[0]!.id).toBe(itemID1)
        // Status should remain active
        expect(itemsAfter[0]!.status).toBe("active")
      },
    })
  })

  test("stale extension event with wrong task/run is ignored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "stale-ext-account"
        const projectID = "stale-ext-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-stale-ext",
          runID: "run-stale-ext-v2",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const originalDeadline = located!.assignment.deadlineAt

        // A stale extension event for a different run should NOT update the deadline
        const staleEvent = extendedTaskFixture({
          agentID: accountId,
          projectID,
          runID: "run-stale-ext-v1", // different run — stale
          task: {
            taskID: "task-stale-ext",
            deadlineAt: new Date(Date.now() + 20_000_000).toISOString(),
            status: "running",
          },
        })

        await handleExtensionEvent(accountId, staleEvent)
        const afterStale = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterStale?.assignment.runID).toBe(event.runID)
        expect(afterStale?.assignment.deadlineAt).toBe(originalDeadline)
      },
    })
  })

  test("stale extension event with wrong taskID is ignored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "stale-task-account"
        const projectID = "stale-task-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-stale-task",
          runID: "run-stale-task",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const originalDeadline = located!.assignment.deadlineAt

        // Extension event for a different task within the same project
        const staleEvent = extendedTaskFixture({
          agentID: accountId,
          projectID,
          runID: "run-stale-task",
          task: {
            taskID: "task-different", // different task — stale
            deadlineAt: new Date(Date.now() + 20_000_000).toISOString(),
            status: "running",
          },
        })

        await handleExtensionEvent(accountId, staleEvent)
        const afterStale = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterStale?.assignment.taskID).toBe(event.taskID)
        expect(afterStale?.assignment.deadlineAt).toBe(originalDeadline)
      },
    })
  })
})

// =============================================================================
// 2. Extension and result independence for deadline
// =============================================================================

describe("Clarus extension deadline and result independence", () => {
  test("extension reschedule does not affect result submission capability", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-result-indep-account"
        const projectID = "ext-result-indep-project"
        const scope = await setupProjectScope(accountId, projectID)
        const taskID = "task-ext-result-indep"
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID,
          runID: "run-ext-result-indep",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)

        // Extend once
        const newDeadline = new Date(Date.now() + 10_800_000).toISOString()
        await ClarusDeadlineAgenda.sync({
          accountId,
          projectID,
          taskID,
          sessionID: created.assignment.sessionID,
          deadlineAt: newDeadline,
          active: true,
        })

        // Extend again
        const laterDeadline = new Date(Date.now() + 20_000_000).toISOString()
        await ClarusDeadlineAgenda.sync({
          accountId,
          projectID,
          taskID,
          sessionID: created.assignment.sessionID,
          deadlineAt: laterDeadline,
          active: true,
        })

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        // Assignment should still be running and accept results
        expect(located!.assignment.status).toBe("running")
        expect(located!.assignment.resultState).toBe("none")
      },
    })
  })

  test("cancel deadline on terminal result removes the Agenda item", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "cancel-dl-result-account"
        const projectID = "cancel-dl-result-project"
        const scope = await setupProjectScope(accountId, projectID)
        const taskID = "task-cancel-dl-result"
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID,
          runID: "run-cancel-dl-result",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)

        // Verify deadline item exists
        const itemsBefore = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(itemsBefore).toHaveLength(1)

        // Cancel via ClarusDeadlineAgenda.cancel (simulates result/submission completion)
        await ClarusDeadlineAgenda.cancel({ accountId, projectID, taskID })

        // Verify deadline item is cancelled
        const itemsAfter = (await AgendaStore.list(scope.id)).filter(
          (i) => i.tags?.includes("deadline") && i.status !== "cancelled" && i.status !== "done",
        )
        expect(itemsAfter).toHaveLength(0)
      },
    })
  })
})

// =============================================================================
// 3. Extension event deduplication for deadline
// =============================================================================

describe("Clarus extension event deduplication", () => {
  test("duplicate extension event does not reschedule Agenda multiple times", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "dedup-ext-account"
        const projectID = "dedup-ext-project"
        const scope = await setupProjectScope(accountId, projectID)
        const taskID = "task-dedup-ext"
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID,
          runID: "run-dedup-ext",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)

        // Get original item count
        const itemsBefore = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(itemsBefore).toHaveLength(1)
        const originalItemID = itemsBefore[0]!.id

        const sameDeadline = event.deadlineAt!
        const extensionEvent = extendedTaskFixture({
          agentID: accountId,
          projectID,
          runID: event.runID,
          requestID: null,
          task: { taskID, deadlineAt: sameDeadline, status: "running" },
        })
        await handleExtensionEvent(accountId, extensionEvent)
        await handleExtensionEvent(accountId, extensionEvent)

        // Should still have exactly one deadline item with the same ID
        const itemsAfter = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(itemsAfter).toHaveLength(1)
        expect(itemsAfter[0]!.id).toBe(originalItemID)
      },
    })
  })
})

// =============================================================================
// 4. Dynamic lead calculation contract
// =============================================================================

describe("ClarusDeadline lead calculation", () => {
  test("short deadline (< 5 min) gets minimum lead of 30s", () => {
    const now = Date.now()
    const deadlineAt = now + 120_000 // 2 minutes from now
    const lead = ClarusDeadline.leadMs(deadlineAt, now)
    expect(lead).toBe(30_000) // 10% of 120s = 12s, clamped to 30s min
  })

  test("medium deadline gets proportional lead capped at 5 min", () => {
    const now = Date.now()
    const deadlineAt = now + 3_600_000 // 1 hour
    const lead = ClarusDeadline.leadMs(deadlineAt, now)
    expect(lead).toBe(300_000) // 10% of 3600s = 360s, clamped to 300s max
  })

  test("long deadline gives maximum lead of 5 min", () => {
    const now = Date.now()
    const deadlineAt = now + 86_400_000 // 24 hours
    const lead = ClarusDeadline.leadMs(deadlineAt, now)
    expect(lead).toBe(300_000) // 10% of 86400s = 8640s, clamped to 300s max
  })

  test("already-near deadline still gets minimum lead", () => {
    const now = Date.now()
    const deadlineAt = now + 15_000 // 15 seconds in the future
    const lead = ClarusDeadline.leadMs(deadlineAt, now)
    expect(lead).toBe(30_000) // Minimum lead
  })

  test("triggerAt places the trigger before the deadline with exactly the lead margin", () => {
    const now = Date.now()
    const deadlineAt = now + 3_600_000
    const trigger = ClarusDeadline.triggerAt(deadlineAt, now)
    expect(trigger).toBe(deadlineAt - ClarusDeadline.leadMs(deadlineAt, now))
  })

  test("triggerAt never fires in the past", () => {
    const now = Date.now()
    const deadlineAt = now - 60_000 // already passed
    const trigger = ClarusDeadline.triggerAt(deadlineAt, now)
    expect(trigger).toBeGreaterThanOrEqual(now + 1_000)
  })

  test("extension changes the effective deadline but Agenda reschedule uses new deadline", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "lead-ext-account"
        const projectID = "lead-ext-project"
        const scope = await setupProjectScope(accountId, projectID)
        const taskID = "task-lead-ext"

        const originalDeadline = new Date(Date.now() + 3_600_000).toISOString()
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID,
          runID: "run-lead-ext",
          deadlineAt: originalDeadline,
        })

        const created = await dispatchAssignment(accountId, event)

        // Extend with a much later deadline
        const newDeadline = new Date(Date.now() + 86_400_000).toISOString() // 24h
        await ClarusDeadlineAgenda.sync({
          accountId,
          projectID,
          taskID,
          sessionID: created.assignment.sessionID,
          deadlineAt: newDeadline,
          active: true,
        })

        // Verify the Agenda item now reflects the new deadline
        const items = (await AgendaStore.list(scope.id)).filter((i) => i.tags?.includes("deadline"))
        expect(items).toHaveLength(1)
        // The item should remain active with updated triggers
        expect(items[0]!.status).toBe("active")
      },
    })
  })
})
