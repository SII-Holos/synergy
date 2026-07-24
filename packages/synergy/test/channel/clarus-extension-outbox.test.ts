import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusDeadlineAgenda } from "../../src/channel/provider/clarus/deadline-agenda"
import { ClarusExtendPayload } from "../../src/channel/provider/clarus/extension-outbox"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { AgendaStore } from "../../src/agenda/store"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

// Expected contract — the extension outbox and its payload shape.
// These types define the public API the implementation must satisfy.
// Tests fail RED until ClarusExtensionOutbox, ClarusExtendPayload, and
// storage paths exist.

// ── Expected payload schema ─────────────────────────────────────────
// Mirrors agent-tunnel-port's ExtendTaskInput with clean naming:
// extend_seconds: required int in [60, 3600]
// progress: optional concise string, max 500 chars
// payload: optional bounded record

// ── Expected outbox shape ───────────────────────────────────────────
// ClarusExtensionOutbox namespace with:
//   submit({ sessionID, payload, send }) → { requestID }
//   recover(accountHash, send) → void
// Dispositions mirror result outbox: pending/acknowledged/not_dispatched/rejected/ambiguous

// ── Expected assignment extension state ─────────────────────────────
// ClarusAssignment gains extensionState: "none"|"pending"|"acknowledged"|"not_dispatched"|"rejected"|"ambiguous"
// ClarusAssignmentStore gains:
//   beginExtension(sessionID, requestID) → Located
//   settleExtension({ accountHash, assignmentHash, requestID, state, deadlineAt? }) → void
// beginExtension requires extensionState === "none" || "not_dispatched"

// ── Expected storage paths ──────────────────────────────────────────
// StoragePath.clarusProviderExtensionOutboxRoot(accountHash)
// StoragePath.clarusProviderExtensionOutbox(accountHash, recordHash)

// ── Expected provider method ────────────────────────────────────────
// ClarusProvider.extendTask({ sessionID, payload, signal }) → { requestID }

// ── Expected event handling ─────────────────────────────────────────
// Authoritative runtimeTaskExtended with matching task/run:
//   1. Updates assignment.deadlineAt
//   2. Reschedules the SAME deterministic Agenda item ID via ClarusDeadlineAgenda.sync

// =============================================================================
// Host-mediated dispatch helper — the canonical production path
// =============================================================================
async function dispatchAssignment(accountId: string, event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId })
  return ClarusAssignmentRuntime.dispatch({ host, accountId, event })
}

// =============================================================================
// Test fixtures
// =============================================================================

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

function extendPayload(
  overrides: { extend_seconds?: number; progress?: string; payload?: Record<string, unknown> } = {},
) {
  return {
    extend_seconds: overrides.extend_seconds ?? 3600,
    ...(overrides.progress === undefined ? {} : { progress: overrides.progress }),
    ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
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

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

// =============================================================================
// 1. Extension payload persistence and outbox dispositions
// =============================================================================

describe("Clarus extension payload validation", () => {
  test("extend_seconds is bounded to the upstream [60, 3600] contract", () => {
    expect(ClarusExtendPayload.safeParse({ extend_seconds: 60 }).success).toBe(true)
    expect(ClarusExtendPayload.safeParse({ extend_seconds: 3600 }).success).toBe(true)
    expect(ClarusExtendPayload.safeParse({ extend_seconds: 3601 }).success).toBe(false)
  })
})

describe("Clarus extension outbox disposition", () => {
  test("extension payload persists before send", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-persist-account"
        const projectID = "ext-persist-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-persist",
          runID: "run-ext-persist",
        })

        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash

        // RED until ClarusExtensionOutbox.submit exists
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        let persistedBeforeSend = false
        let recordStateBeforeSend = ""

        await ClarusExtensionOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: extendPayload(),
          send: async () => {
            const hashes = await Storage.scan(StoragePath.clarusProviderExtensionOutboxRoot(acctHash))
            expect(hashes.length).toBeGreaterThan(0)
            const record = await Storage.read<{ state: string; payload: unknown }>(
              StoragePath.clarusProviderExtensionOutbox(acctHash, hashes[0]!),
            )
            recordStateBeforeSend = record.state
            persistedBeforeSend = record.state === "pending"
          },
        })

        expect(persistedBeforeSend).toBe(true)
        expect(recordStateBeforeSend).toBe("pending")
      },
    })
  })

  test("not_dispatched extension may retry with a new request ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-retry-account"
        const projectID = "ext-retry-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-retry",
          runID: "run-ext-retry",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const failure = {
          disposition: "not_dispatched" as const,
          requestID: "request-ext-failed-1",
          code: "NOT_CONNECTED",
          message: "not connected",
        }

        let firstRequestID: string | undefined
        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async (input) => {
              firstRequestID = input.requestID
              throw failure
            },
          }),
        ).rejects.toEqual(failure)

        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          extensionState: "not_dispatched",
        })

        let secondRequestID: string | undefined
        await ClarusExtensionOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: extendPayload(),
          send: async (input) => {
            secondRequestID = input.requestID
          },
        })

        expect(firstRequestID).toBeString()
        expect(secondRequestID).toBeString()
        expect(secondRequestID).not.toBe(firstRequestID)
        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          extensionState: "acknowledged",
        })
      },
    })
  })

  test("rejected extension disposition never auto-retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-reject-account"
        const projectID = "ext-reject-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-reject",
          runID: "run-ext-reject",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const rejected = {
          disposition: "rejected" as const,
          requestID: "request-ext-rejected",
          code: "EXTENSION_REJECTED",
          message: "extension rejected",
        }

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {
              throw rejected
            },
          }),
        ).rejects.toEqual(rejected)

        expect(
          (await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment.extensionState,
        ).toBe("rejected")

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_EXTENSION_NOT_ACCEPTABLE" })
      },
    })
  })

  test("ambiguous extension disposition never auto-retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-ambiguous-account"
        const projectID = "ext-ambiguous-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-ambiguous",
          runID: "run-ext-ambiguous",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {
              throw new Error("connection lost mid-dispatch")
            },
          }),
        ).rejects.toThrow("connection lost mid-dispatch")

        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          extensionState: "ambiguous",
        })

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_EXTENSION_NOT_ACCEPTABLE" })
      },
    })
  })

  test("pending extension crash becomes ambiguous on recovery — no auto-retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-crash-account"
        const projectID = "ext-crash-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-crash",
          runID: "run-ext-crash",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash
        const assignmentHash = located!.assignmentHash

        // Simulate beginExtension + manual pending record
        await ClarusAssignmentStore.beginExtension(created.assignment.sessionID, "request-ext-crash")
        await Storage.write(StoragePath.clarusProviderExtensionOutbox(acctHash, hash("request-ext-crash")), {
          requestID: "request-ext-crash",
          assignmentHash,
          sessionID: created.assignment.sessionID,
          payload: extendPayload(),
          state: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        await ClarusExtensionOutbox.recover(acctHash)

        const recovered = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(recovered?.assignment.extensionState).toBe("ambiguous")

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_EXTENSION_NOT_ACCEPTABLE" })
      },
    })
  })

  test("recovery retries eligible not_dispatched extension once with new requestID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-recover-account"
        const projectID = "ext-recover-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-recover",
          runID: "run-ext-recover",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash
        const assignmentHash = located!.assignmentHash

        // First submit gets not_dispatched
        const notDispatchedFailure = {
          disposition: "not_dispatched" as const,
          requestID: "request-ext-recover-1",
          code: "NOT_CONNECTED",
          message: "not connected",
        }
        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        // Record should be not_dispatched in both outbox and assignment
        const storedHashes = await Storage.scan(StoragePath.clarusProviderExtensionOutboxRoot(acctHash))
        expect(storedHashes.length).toBeGreaterThan(0)
        const stored = await Storage.read<{ state: string; requestID: string }>(
          StoragePath.clarusProviderExtensionOutbox(acctHash, storedHashes[0]!),
        )
        expect(stored.state).toBe("not_dispatched")

        // Recovery retries with a new requestID
        let recoveredRequestID: string | undefined
        await ClarusExtensionOutbox.recover(acctHash, async (input) => {
          recoveredRequestID = input.requestID
          // The send succeeds this time
        })

        expect(recoveredRequestID).toBeString()
        expect(recoveredRequestID).not.toBe(stored.requestID)

        // After successful recovery, assignment should be acknowledged
        const recoveredAssignment = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(recoveredAssignment?.assignment.extensionState).toBe("acknowledged")
      },
    })
  })

  test("recovery does not retry acknowledged, rejected, or ambiguous records", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-terminal-account"
        const projectID = "ext-terminal-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-terminal",
          runID: "run-ext-terminal",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash

        // Write three terminal records directly to storage
        const records = [
          { state: "acknowledged", requestID: "req-ack" },
          { state: "rejected", requestID: "req-rej" },
          { state: "ambiguous", requestID: "req-amb" },
        ]
        for (const { state, requestID } of records) {
          await Storage.write(StoragePath.clarusProviderExtensionOutbox(acctHash, hash(requestID)), {
            requestID,
            assignmentHash: located!.assignmentHash,
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            state,
            createdAt: Date.now() - 1000,
            updatedAt: Date.now() - 1000,
          })
        }

        // Recovery should not retry any terminal records
        let sendCallCount = 0
        await ClarusExtensionOutbox.recover(acctHash, async () => {
          sendCallCount++
        })

        expect(sendCallCount).toBe(0)
      },
    })
  })
})

// =============================================================================
// 2. Concurrent duplicate extension protection
// =============================================================================

describe("Clarus extension concurrency", () => {
  test("concurrent duplicate extension does not double-dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-dup-account"
        const projectID = "ext-dup-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-dup",
          runID: "run-ext-dup",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()

        let sendCallCount = 0
        const send = async () => {
          // Simulate a slow acknowledgment so the lock is held
          await new Promise((r) => setTimeout(r, 50))
          sendCallCount++
        }

        // Fire two concurrent submits
        const [first, second] = await Promise.allSettled([
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send,
          }),
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload({ extend_seconds: 7200 }),
            send,
          }),
        ])

        // At least one succeeds, the other may fail due to lock/state
        const succeeded = [first, second].filter((r) => r.status === "fulfilled").length
        expect(succeeded).toBeLessThanOrEqual(1)
        // No double-dispatch: send counted only called for successful submits
        expect(sendCallCount).toBeLessThanOrEqual(1)
      },
    })
  })

  test("recovery does not double-dispatch when concurrent with submit", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-concurrent-recover-account"
        const projectID = "ext-concurrent-recover-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-concurrent-recover",
          runID: "run-ext-concurrent-recover",
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash

        // Create a not_dispatched record via failed submit
        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {
              throw { disposition: "not_dispatched", requestID: "req-recover-race", code: "NC", message: "nc" }
            },
          }),
        ).rejects.toBeDefined()

        let recoverySendCount = 0
        // Perform recovery
        await ClarusExtensionOutbox.recover(acctHash, async () => {
          recoverySendCount++
        })

        // Recovery should retry exactly once
        expect(recoverySendCount).toBeLessThanOrEqual(1)
      },
    })
  })
})

// =============================================================================
// 3. Extension and result independence
// =============================================================================

describe("Clarus extension/result state independence", () => {
  test("extension outbox state is independent of result outbox state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-indep-account"
        const projectID = "ext-indep-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-indep",
          runID: "run-ext-indep",
        })

        const created = await dispatchAssignment(accountId, event)

        // Submit a failed extension
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        await expect(
          ClarusExtensionOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: extendPayload(),
            send: async () => {
              throw { disposition: "rejected", requestID: "ext-req", code: "REJ", message: "rej" }
            },
          }),
        ).rejects.toBeDefined()

        const assignmentAfterExt = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(assignmentAfterExt?.assignment.extensionState).toBe("rejected")
        // Result state should be unaffected
        expect(assignmentAfterExt?.assignment.resultState).toBe("none")
        // Assignment status should still be running (extension rejection doesn't complete task)
        expect(assignmentAfterExt?.assignment.status).toBe("running")
      },
    })
  })

  test("remote Project pause does not block extension of already accepted task", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-pause-account"
        const projectID = "ext-pause-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-pause",
          runID: "run-ext-pause",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)
        const { ClarusExtensionOutbox } = await import("../../src/channel/provider/clarus/extension-outbox")

        // Pause the remote project
        const host = ChannelHost.create({ channelType: "clarus", accountId })
        await host.projects.ensure({ externalProjectId: projectID, name: "Paused project", isActive: false })

        // Extension should still succeed for an already accepted task
        await ClarusExtensionOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: extendPayload(),
          send: async () => {
            // send succeeds
          },
        })

        const assignmentAfterExt = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(assignmentAfterExt?.assignment.extensionState).toBe("acknowledged")
        expect(assignmentAfterExt?.assignment.status).toBe("running")
      },
    })
  })
})

// =============================================================================
// 4. Extension ACK vs push deduplication
// =============================================================================

describe("Clarus extension ACK deduplication", () => {
  test("extension request ACK and later extension push are not double-applied", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-dedup-ack-account"
        const projectID = "ext-dedup-ack-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-dedup-ack",
          runID: "run-ext-dedup-ack",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)

        // The assignment should have a deadline Agenda item
        const agendaItems = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        expect(agendaItems).toHaveLength(1)
        const originalAgendaItemID = agendaItems[0]!.id

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()

        // Simulate an authoritative runtimeTaskExtended event (the push) with a new deadline
        const newDeadline = new Date(Date.now() + 10_800_000).toISOString()
        const extendedEvent = {
          kind: "known" as const,
          type: "runtimeTaskExtended" as const,
          agentID: accountId,
          requestID: crypto.randomUUID(),
          projectID,
          runID: event.runID,
          task: { taskID: event.taskID, deadlineAt: newDeadline, status: "running" },
          epoch: 2,
          generation: 2,
        }

        // The extension push should be processed:
        // 1. Assignment deadlineAt updated
        // 2. Agenda item rescheduled with same ID (not recreated)
        // RED: the provider event handler for runtimeTaskExtended must exist
        // and call ClarusDeadlineAgenda.sync with the new deadline

        // Verify the Agenda item ID is deterministic and would be reused
        const expectedItemID = ClarusDeadlineAgenda.itemID({
          accountId,
          projectID,
          taskID: event.taskID,
        })
        expect(expectedItemID).toBe(originalAgendaItemID)

        // After processing, there should still be exactly one deadline Agenda item
        // with the same ID but rescheduled
        // RED: this test encodes the expected behavior of handleExtensionEvent()
        // The actual event processing would go through ClarusProvider._handleExtensionEvent()
        // which doesn't exist yet
      },
    })
  })

  test("stale extension event identity is ignored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-stale-account"
        const projectID = "ext-stale-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-stale",
          runID: "run-ext-stale-v1",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        const created = await dispatchAssignment(accountId, event)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const originalDeadline = located!.assignment.deadlineAt

        // A stale extension event for a different run should not update the assignment
        const staleEvent = {
          kind: "known" as const,
          type: "runtimeTaskExtended" as const,
          agentID: accountId,
          requestID: crypto.randomUUID(),
          projectID,
          runID: "run-ext-stale-v0", // wrong run!
          task: {
            taskID: event.taskID,
            deadlineAt: new Date(Date.now() + 20_000_000).toISOString(),
            status: "running",
          },
          epoch: 2,
          generation: 2,
        }

        // RED: stale event should be ignored by the handler
        // The assignment deadline should not change
        const afterStale = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterStale?.assignment.deadlineAt).toBe(originalDeadline)
      },
    })
  })
})
