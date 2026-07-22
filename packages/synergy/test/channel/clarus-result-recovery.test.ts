import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusResultOutbox } from "../../src/channel/provider/clarus/result-outbox"
import { ClarusProvider } from "../../src/channel/provider/clarus/index"
import type {
  RuntimeTaskAssignedEvent,
  ClarusAgentTunnelPort,
} from "../../src/channel/provider/clarus/agent-tunnel-port"
import { ClarusDeadlineAgenda } from "../../src/channel/provider/clarus/deadline-agenda"
import { AgendaStore } from "../../src/agenda/store"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

// =============================================================================
// Helpers
// =============================================================================

function assignmentFixture(overrides: Partial<RuntimeTaskAssignedEvent> = {}): RuntimeTaskAssignedEvent {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "test-recovery-agent",
    requestID: crypto.randomUUID(),
    projectID: "recovery-project",
    runID: `recovery-run-${crypto.randomUUID()}`,
    taskID: `recovery-task-${crypto.randomUUID()}`,
    phase: "implementation",
    subtaskID: `recovery-subtask-${crypto.randomUUID()}`,
    attempt: 1,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    goal: "Implement recovery",
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

function resultPayload() {
  return {
    success: true,
    output: "Done",
    artifacts: [],
    evidenceRefs: [],
    notaryRefs: [],
    error: null,
    submittedBy: "synergy",
  }
}

const notDispatchedFailure = {
  disposition: "not_dispatched" as const,
  requestID: "fail-nd",
  code: "NOT_CONNECTED",
  message: "not connected",
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

function hash(...parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

// =============================================================================
// 1. Recovery retry — not_dispatched records
// =============================================================================

describe("Clarus result recovery retry", () => {
  test("not_dispatched record is retried on reconnect recovery with fresh requestID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "retry-rec-account"
        const projectID = "retry-rec-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-retry-nd",
          runID: "run-retry-nd",
        })
        const created = await dispatchAssignment(accountId, event)

        // Fail a submission with not_dispatched — this creates a real outbox record
        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located?.assignment.resultState).toBe("not_dispatched")

        // Verify an outbox record exists
        const beforeHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))
        const ndRecord = await Storage.read<{ state: string; requestID: string }>(
          StoragePath.clarusProviderResultOutbox(located!.accountHash, beforeHashes[0]!),
        )
        expect(ndRecord.state).toBe("not_dispatched")

        // Attempt recovery with a send callback (future API shape)
        let retried = false
        let retriedRequestID: string | undefined
        try {
          await (ClarusResultOutbox.recover as any)({
            accountHash: located!.accountHash,
            send: async (input: { requestID: string }) => {
              retried = true
              retriedRequestID = input.requestID
            },
          })
        } catch {
          // recover may throw or silently ignore — we assert on retried flag
        }

        // RED: recover currently ignores send callback; not_dispatched is never retried
        expect(retried).toBe(true)
        expect(retriedRequestID).toBeString()
        expect(retriedRequestID).not.toBe(ndRecord.requestID)
      },
    })
  })

  test("latest pending crash becomes ambiguous and superseded not_dispatched is not retried", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "pending-rec-account"
        const projectID = "pending-rec-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-pending-amb",
          runID: "run-pending-amb",
        })
        const created = await dispatchAssignment(accountId, event)

        // Create a not_dispatched record, then supersede it with a newer pending request
        // to simulate a crash after the user explicitly retried.
        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        const acctHash = located!.accountHash

        // Manually write a pending outbox record
        await ClarusAssignmentStore.beginResult(created.assignment.sessionID, "request-pending-crash")
        await Storage.write(StoragePath.clarusProviderResultOutbox(acctHash, "record-pending-crash"), {
          requestID: "request-pending-crash",
          assignmentHash: located!.assignmentHash,
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          state: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        let sendCalls = 0
        await ClarusResultOutbox.recover({
          accountHash: acctHash,
          send: async () => {
            sendCalls++
          },
        })

        const outboxRecord = await Storage.read<{ state: string }>(
          StoragePath.clarusProviderResultOutbox(acctHash, "record-pending-crash"),
        )
        expect(outboxRecord.state).toBe("ambiguous")
        expect(sendCalls).toBe(0)

        const recovered = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(recovered?.assignment).toMatchObject({
          resultState: "ambiguous",
          resultRequestID: "request-pending-crash",
        })
      },
    })
  })

  test("rejected and ambiguous records are never sent during recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "term-rec-account"
        const projectID = "term-rec-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-term",
          runID: "run-term",
        })
        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        const acctHash = located!.accountHash

        // Create a not_dispatched record, a rejected record, and an ambiguous record
        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        // Create rejected outbox record directly
        await Storage.write(StoragePath.clarusProviderResultOutbox(acctHash, "record-rejected"), {
          requestID: "request-rejected-term",
          assignmentHash: located!.assignmentHash,
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          state: "rejected",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        // Create ambiguous outbox record directly
        await Storage.write(StoragePath.clarusProviderResultOutbox(acctHash, "record-ambiguous"), {
          requestID: "request-ambiguous-term",
          assignmentHash: located!.assignmentHash,
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          state: "ambiguous",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        const sentRequestIDs: string[] = []
        await ClarusResultOutbox.recover({
          accountHash: acctHash,
          send: async (input) => {
            sentRequestIDs.push(input.requestID)
          },
        })

        expect(sentRequestIDs).toHaveLength(1)
        const records = await Promise.all(
          (await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(acctHash))).map((recordHash) =>
            Storage.read<{ requestID: string; state: string }>(
              StoragePath.clarusProviderResultOutbox(acctHash, recordHash),
            ),
          ),
        )
        expect(records.find((record) => record.requestID === "request-rejected-term")?.state).toBe("rejected")
        expect(records.find((record) => record.requestID === "request-ambiguous-term")?.state).toBe("ambiguous")
        expect(
          records.some((record) => record.requestID === sentRequestIDs[0] && record.state === "acknowledged"),
        ).toBe(true)
      },
    })
  })

  test("concurrent recovery calls dispatch exactly one eligible retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "concur-rec-account"
        const projectID = "concur-rec-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-concur",
          runID: "run-concur",
        })
        const created = await dispatchAssignment(accountId, event)

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        const acctHash = located!.accountHash

        let sendCalls = 0
        const send = async () => {
          sendCalls++
        }

        // Two concurrent recover calls
        await Promise.allSettled([
          (ClarusResultOutbox.recover as any)({ accountHash: acctHash, send }),
          (ClarusResultOutbox.recover as any)({ accountHash: acctHash, send }),
        ])

        // RED: sendCalls will be 0 because recover ignores send callback entirely
        expect(sendCalls).toBe(1)
      },
    })
  })
})

// =============================================================================
// 2. Stale requestID guard
// =============================================================================

describe("Stale requestID guard", () => {
  test("stale pending record from older requestID does not overwrite newer assignment state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "stale-rec-account"
        const projectID = "stale-rec-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-stale",
          runID: "run-stale",
        })
        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)

        // First submission fails with not_dispatched — capture the ACTUAL requestID
        // generated by ClarusResultOutbox.submit
        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw notDispatchedFailure
            },
          }),
        ).rejects.toEqual(notDispatchedFailure)

        const afterFirst = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterFirst?.assignment.resultState).toBe("not_dispatched")
        const firstRequestID = afterFirst!.assignment.resultRequestID
        expect(firstRequestID).toBeString()

        // Second submission succeeds
        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async () => {},
        })

        const afterSecond = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterSecond?.assignment.resultState).toBe("acknowledged")
        expect(afterSecond?.assignment.resultRequestID).not.toBe(firstRequestID)

        // Now try to settle with the stale requestID — must be a no-op
        await ClarusAssignmentStore.settleResult({
          accountHash: located!.accountHash,
          assignmentHash: located!.assignmentHash,
          requestID: firstRequestID!,
          state: "ambiguous",
        })

        // Assignment must still be acknowledged with the new requestID
        const final = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(final?.assignment.resultState).toBe("acknowledged")
        expect(final?.assignment.status).toBe("completed")
      },
    })
  })
})

// =============================================================================
// 3. Authoritative runtimeTaskResultRecorded event handling
// =============================================================================

describe("Authoritative runtimeTaskResultRecorded reconciliation", () => {
  let provider: ClarusProvider
  let accountId: string
  let projectID: string
  let scope: any
  let host: ReturnType<typeof ChannelHost.create>

  // Track stored assignment details across tests
  let currentSessionID: string | undefined
  let currentAssignmentHash: string | undefined
  let currentAccountHash: string | undefined

  /**
   * Build a fake ClarusAgentTunnelPort stub for provider event tests.
   * The tunnel is never connected — we call handleEvent directly.
   */
  function stubTunnel(): ClarusAgentTunnelPort {
    return {
      registerEventHandler: () => () => {},
      registerConnectionHandler: () => () => {},
      subscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
      unsubscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
      extendTask: () => ({ requestID: "", response: Promise.resolve({} as any) }),
      recordTaskResult: () => ({ requestID: "", response: Promise.resolve({} as any) }),
    }
  }

  async function createRunningAssignment(opts: { taskID: string; runID: string; subtaskID: string }) {
    const event = assignmentFixture({
      agentID: accountId,
      projectID,
      taskID: opts.taskID,
      runID: opts.runID,
      subtaskID: opts.subtaskID,
    })
    const created = await dispatchAssignment(accountId, event)
    const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
    currentSessionID = created.assignment.sessionID
    currentAssignmentHash = located!.assignmentHash
    currentAccountHash = located!.accountHash
    return created
  }

  beforeEach(async () => {
    // Each test gets a fresh tmp and Scope
    accountId = `event-${crypto.randomUUID().slice(0, 8)}`
    projectID = `event-project-${crypto.randomUUID().slice(0, 8)}`
    provider = new ClarusProvider()
    host = ChannelHost.create({ channelType: "clarus", accountId })
  })

  afterEach(() => {
    currentSessionID = undefined
    currentAssignmentHash = undefined
    currentAccountHash = undefined
  })

  test("authoritative result-recorded event with matching requestID settles acknowledged and cancels deadline", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        scope = await setupProjectScope(accountId, projectID)
        const created = await createRunningAssignment({
          taskID: "task-auth-event",
          runID: "run-auth-event",
          subtaskID: "subtask-auth-event",
        })

        // Verify deadline was created by dispatch
        const deadlineItemsBefore = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        expect(deadlineItemsBefore.length).toBeGreaterThan(0)

        // Submit a result with a known requestID — we need the assignment
        // to have a resultRequestID set before the event arrives
        let capturedRequestID: string | undefined
        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async (input) => {
            capturedRequestID = input.requestID
          },
        })
        expect(capturedRequestID).toBeString()

        // Verify result was acknowledged
        const afterSubmit = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterSubmit?.assignment.resultState).toBe("acknowledged")

        // Now test the scenario: imagine the assignment is back to "running"
        // with a result already recorded on the Clarus side
        // We need the provider to handle a runtimeTaskResultRecorded event
        // that matches the assignment. Re-create the assignment in pending state.
        const event2 = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-auth-event-2",
          runID: "run-auth-event-2",
          subtaskID: "subtask-auth-event-2",
        })
        const created2 = await dispatchAssignment(accountId, event2)

        // Begin result to set a known requestID
        const pending = await ClarusAssignmentStore.beginResult(created2.assignment.sessionID, "req-auth-match")
        const afterBegin = await ClarusAssignmentStore.findBySessionID(created2.assignment.sessionID)

        // Emit a matching runtimeTaskResultRecorded event
        const connection = {
          accountId,
          config: {} as any,
          tunnel: stubTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map<string, string>(),
          outboundRequests: new Set<string>(),
        }

        const event3 = {
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: accountId,
          requestID: "req-auth-match",
          projectID,
          runID: "run-auth-event-2",
          task: { taskID: "task-auth-event-2", subtaskID: "subtask-auth-event-2", status: "completed" },
          epoch: 1,
          generation: 1,
        }

        await (provider as any).handleEvent(connection, event3)

        // RED: handleEvent falls to default case and returns without processing
        // The assignment state should be acknowledged after authoritative event
        const afterEvent = await ClarusAssignmentStore.findBySessionID(created2.assignment.sessionID)
        expect(afterEvent?.assignment.resultState).toBe("acknowledged")
        expect(afterEvent?.assignment.status).toBe("completed")

        // RED: Deadline should be cancelled
        const deadlineItemsAfter = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        const matchDeadline = deadlineItemsAfter.find(
          (item) => item.id === ClarusDeadlineAgenda.itemID({ accountId, projectID, taskID: "task-auth-event-2" }),
        )
        expect(matchDeadline?.status === "cancelled").toBe(true)
      },
    })
  })

  test("stale/mismatched requestID at runtimeTaskResultRecorded is ignored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        scope = await setupProjectScope(accountId, projectID)
        const created = await createRunningAssignment({
          taskID: "task-stale-event",
          runID: "run-stale-event",
          subtaskID: "subtask-stale-event",
        })

        // Submit result to set acknowledged state
        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async () => {},
        })

        const beforeEvent = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(beforeEvent?.assignment.resultState).toBe("acknowledged")

        const connection = {
          accountId,
          config: {} as any,
          tunnel: stubTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map<string, string>(),
          outboundRequests: new Set<string>(),
        }

        // Emit a stale event with a different requestID
        const staleEvent = {
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: accountId,
          requestID: "some-stale-request-id",
          projectID,
          runID: "run-stale-event",
          task: { taskID: "task-stale-event", subtaskID: "subtask-stale-event", status: "completed" },
          epoch: 1,
          generation: 1,
        }

        await (provider as any).handleEvent(connection, staleEvent)

        // RED: Currently ignored by design, but must remain a no-op after implementation
        // Assignment must remain acknowledged — stale event must not change state
        const afterEvent = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterEvent?.assignment.resultState).toBe("acknowledged")
      },
    })
  })

  test("unsolicited result-recorded event with null requestID reconciles in-flight only, not state none", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        scope = await setupProjectScope(accountId, projectID)

        // Create an assignment in state "none" (no result submitted)
        const createdNone = await createRunningAssignment({
          taskID: "task-unsol-none",
          runID: "run-unsol-none",
          subtaskID: "subtask-unsol-none",
        })

        const connection = {
          accountId,
          config: {} as any,
          tunnel: stubTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map<string, string>(),
          outboundRequests: new Set<string>(),
        }

        // Unsolicited event: null requestID, task status "completed"
        const unsolicitedEventNone = {
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: accountId,
          requestID: null,
          projectID,
          runID: "run-unsol-none",
          task: { taskID: "task-unsol-none", subtaskID: "subtask-unsol-none", status: "completed" },
          epoch: 1,
          generation: 1,
        }

        await (provider as any).handleEvent(connection, unsolicitedEventNone)

        // RED: Unsolicited event must NOT manufacture a result for state "none"
        const afterNone = await ClarusAssignmentStore.findBySessionID(createdNone.assignment.sessionID)
        expect(afterNone?.assignment.resultState).toBe("none")

        // Now create an assignment with an in-flight pending result
        const createdPending = await createRunningAssignment({
          taskID: "task-unsol-pending",
          runID: "run-unsol-pending",
          subtaskID: "subtask-unsol-pending",
        })

        await ClarusAssignmentStore.beginResult(createdPending.assignment.sessionID, "req-inflight")

        // Unsolicited event for the in-flight assignment
        const unsolicitedEventPending = {
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: accountId,
          requestID: null,
          projectID,
          runID: "run-unsol-pending",
          task: { taskID: "task-unsol-pending", subtaskID: "subtask-unsol-pending", status: "completed" },
          epoch: 1,
          generation: 1,
        }

        await (provider as any).handleEvent(connection, unsolicitedEventPending)

        // RED: Unsolicited event with null requestID must reconcile in-flight result to acknowledged
        const afterPending = await ClarusAssignmentStore.findBySessionID(createdPending.assignment.sessionID)
        expect(afterPending?.assignment.resultState).toBe("acknowledged")
        expect(afterPending?.assignment.status).toBe("completed")
      },
    })
  })

  test("mismatched runID or taskID at runtimeTaskResultRecorded is ignored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        scope = await setupProjectScope(accountId, projectID)
        const created = await createRunningAssignment({
          taskID: "task-mismatch",
          runID: "run-mismatch-real",
          subtaskID: "subtask-mismatch",
        })

        await ClarusAssignmentStore.beginResult(created.assignment.sessionID, "req-mismatch")

        const connection = {
          accountId,
          config: {} as any,
          tunnel: stubTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map<string, string>(),
          outboundRequests: new Set<string>(),
        }

        // Event with a different runID
        const mismatchEvent = {
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: accountId,
          requestID: "req-mismatch",
          projectID,
          runID: "run-mismatch-wrong",
          task: { taskID: "task-mismatch", subtaskID: "subtask-mismatch", status: "completed" },
          epoch: 1,
          generation: 1,
        }

        await (provider as any).handleEvent(connection, mismatchEvent)

        // RED: Mismatched runID must be ignored — assignment stays pending
        const afterEvent = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(afterEvent?.assignment.resultState).toBe("pending")
        expect(afterEvent?.assignment.resultRequestID).toBe("req-mismatch")
      },
    })
  })
})

// =============================================================================
// 4. Project pause does not block result flow
// =============================================================================

describe("Project pause does not block result flow", () => {
  test("remote project pause does not block result submission", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "pause-res-account"
        const projectID = "pause-res-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-pause-res",
          runID: "run-pause-res",
        })
        const created = await dispatchAssignment(accountId, event)

        // Mark the project as paused (inactive)
        const host = ChannelHost.create({ channelType: "clarus", accountId })
        await host.projects.ensure({ externalProjectId: projectID, name: "Paused Project", isActive: false })

        // Result submission must still work even with paused project
        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async () => {},
        })

        const final = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(final?.assignment.resultState).toBe("acknowledged")
        expect(final?.assignment.status).toBe("completed")
      },
    })
  })
})
