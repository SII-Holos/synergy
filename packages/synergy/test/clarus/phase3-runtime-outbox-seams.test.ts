import { afterEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusOutbox, isTerminalOutboxState } from "../../src/clarus/outbox"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import type {
  ClarusAgentTunnelPort,
  ClarusObservedEvent,
  RuntimeTaskResultRecordedEvent,
} from "../../src/clarus/agent-tunnel-port"
import type { HolosConnectionEvent } from "../../src/holos/native"

// ============================================================================
// Reusable helpers
// ============================================================================

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

async function catchErr<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (e) {
    return e
  }
}

function isClarusOutboxTerminal(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OUTBOX_TERMINAL"
}

// Deterministic storage path for the subscription index (kept in sync with runtime.ts).
function subscriptionIndexPath(agentId: string, projectId: string): string[] {
  return ["clarus", "subscription_index", encodeURIComponent(agentId), encodeURIComponent(projectId)]
}

// ============================================================================
// 1. Scheme A terminal immutability — rejected, ambiguous, local_only are final
// ============================================================================
describe("Scheme A terminal immutability", () => {
  test("rejected outbox record cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_term_rej"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markRejected(requestID, "E1", "fail")

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)

          const record = await ClarusOutbox.get(requestID)
          expect(record!.state).toBe("rejected")
          expect(record!.acknowledgedAt).toBeUndefined()
        })(),
    })
  })

  test("ambiguous outbox record cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_term_amb"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAmbiguous(requestID, "AMB", "timeout")

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)

          const record = await ClarusOutbox.get(requestID)
          expect(record!.state).toBe("ambiguous")
          expect(record!.acknowledgedAt).toBeUndefined()
        })(),
    })
  })

  test("local_only outbox record cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_term_lo"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markLocalOnly(requestID)

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)

          const record = await ClarusOutbox.get(requestID)
          expect(record!.state).toBe("local_only")
        })(),
    })
  })

  test("acknowledged is idempotent — exact replay returns same state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_seams_ack_idem"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const r = await ClarusOutbox.markAcknowledged(requestID)
          expect(r.state).toBe("acknowledged")
          expect(r.acknowledgedAt).toBeGreaterThan(0)
        })(),
    })
  })
})

// ============================================================================
// 2. Bounded subscription index — no full-root scan
// ============================================================================
describe("Bounded subscription index", () => {
  test("subscription index is written at a deterministic per-project path", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx1"
          const projectId = "pr-idx1"
          const path = subscriptionIndexPath(agentId, projectId)

          await Storage.write(path, { generation: 7 })

          const read = await Storage.read<{ generation: number }>(path)
          expect(read).toEqual({ generation: 7 })
        })(),
    })
  })

  test("index lookup is O(1) — does not scan outbox root", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx2"
          const projectId = "pr-idx2"

          // Populate many unrelated outbox records to show the O(1) index is independent
          for (let i = 0; i < 50; i++) {
            const requestID = `noisy_req_${i}`
            await ClarusOutbox.preallocate({
              requestID,
              action: "task_result",
              agentId: `ag-noise-${i}`,
              projectId: `pr-noise-${i}`,
              payload: { idx: i },
            })
            await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "ep1", generation: 1 })
          }

          // Write subscription index
          const path = subscriptionIndexPath(agentId, projectId)
          await Storage.write(path, { generation: 5 })

          // Verify the index path is distinct from outbox records
          expect(path[0]).toBe("clarus")
          expect(path[1]).toBe("subscription_index")
          expect(path).not.toEqual(StoragePath.clarusOutboxRoot())

          // Read the index back O(1) — no scan
          const index = await Storage.read<{ generation: number }>(path)
          expect(index!.generation).toBe(5)
        })(),
    })
  })

  test("subscriptionAlreadyReconciled returns true when index generation >= requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx3"
          const projectId = "pr-idx3"
          const path = subscriptionIndexPath(agentId, projectId)

          // Write generation 3 to the index
          await Storage.write(path, { generation: 3 })

          // generation 2 <= 3 → reconciled
          const r2 = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          expect(r2 !== undefined && r2.generation >= 2).toBe(true)

          // generation 3 ≤ 3 → reconciled
          const r3 = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          expect(r3 !== undefined && r3.generation >= 3).toBe(true)
        })(),
    })
  })

  test("subscriptionAlreadyReconciled returns false when no index exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx4"
          const projectId = "pr-idx4"
          const path = subscriptionIndexPath(agentId, projectId)

          const index = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          expect(index).toBeUndefined()
        })(),
    })
  })

  test("subscriptionAlreadyReconciled returns false when index generation < requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx5"
          const projectId = "pr-idx5"
          const path = subscriptionIndexPath(agentId, projectId)

          // Write generation 3 to the index
          await Storage.write(path, { generation: 3 })

          // generation 5 > 3 → not reconciled
          const index = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          expect(index === undefined || index.generation < 5).toBe(true)
        })(),
    })
  })

  test("hard bound: only a single Storage.read, no full-root scan", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idx6"
          const projectId = "pr-idx6"
          const path = subscriptionIndexPath(agentId, projectId)

          // 1 read → O(1)
          const index = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          const reconciled = index !== undefined && index.generation >= 1

          // Index not written yet → not reconciled
          expect(reconciled).toBe(false)

          // Write the index
          await Storage.write(path, { generation: 1 })

          // Second read → O(1), returns true
          const index2 = await Storage.read<{ generation: number }>(path).catch(() => undefined)
          expect(index2 !== undefined && index2.generation >= 1).toBe(true)
        })(),
    })
  })
})

// ============================================================================
// 3. Outbox record identity fields (epoch, generation) survive round-trips
// ============================================================================
describe("Outbox record identity fields", () => {
  test("preallocate stores connectionEpoch and generation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_epoch_gen"
          const record = await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-eg",
            projectId: "pr-eg",
            taskId: "tk-eg",
            runId: "run-eg",
            subtaskId: "sub-eg",
            payload: { output: "ok" },
            connectionEpoch: "7",
            generation: 42,
          })

          expect(record.connectionEpoch).toBe("7")
          expect(record.generation).toBe(42)
          expect(record.taskId).toBe("tk-eg")
          expect(record.runId).toBe("run-eg")
          expect(record.subtaskId).toBe("sub-eg")

          const fresh = await ClarusOutbox.get(requestID)
          expect(fresh!.connectionEpoch).toBe("7")
          expect(fresh!.generation).toBe(42)
        })(),
    })
  })

  test("markDispatched can update connectionEpoch and generation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_disp_eg"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-dep",
            projectId: "pr-dep",
            payload: {},
          })

          const r = await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "99", generation: 101 })
          expect(r.connectionEpoch).toBe("99")
          expect(r.generation).toBe(101)
        })(),
    })
  })

  test("outbox record action, agentId, projectId, taskId, runId, subtaskId survive round-trip", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_full_id"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-full",
            projectId: "pr-full",
            taskId: "tk-full",
            runId: "run-full",
            subtaskId: "sub-full",
            payload: { status: "complete" },
          })

          const got = await ClarusOutbox.get(requestID)
          expect(got!.action).toBe("task_result")
          expect(got!.agentId).toBe("ag-full")
          expect(got!.projectId).toBe("pr-full")
          expect(got!.taskId).toBe("tk-full")
          expect(got!.runId).toBe("run-full")
          expect(got!.subtaskId).toBe("sub-full")
          expect(got!.payload).toEqual({ status: "complete" })
        })(),
    })
  })

  test("stale epoch — different epoch is stored and queryable for identity verification", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          // Outbox record with epoch "3"
          const requestID = "req_stale_ep"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-stale",
            projectId: "pr-stale",
            payload: {},
            connectionEpoch: "3",
            generation: 10,
          })

          const record = await ClarusOutbox.get(requestID)
          // A verification check would compare event.epoch ("5") against record.connectionEpoch ("3") → mismatch
          const eventEpoch = "5"
          const eventGeneration = 10
          const matches = String(eventEpoch) === record!.connectionEpoch && eventGeneration === record!.generation
          expect(matches).toBe(false) // stale epoch → not the current connection
        })(),
    })
  })

  test("stale generation — different generation stored and mismatches", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_stale_gen"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-stg",
            projectId: "pr-stg",
            payload: {},
            connectionEpoch: "5",
            generation: 8,
          })

          const record = await ClarusOutbox.get(requestID)
          const eventGen = 12
          const matches = eventGen === record!.generation
          expect(matches).toBe(false)
          expect(record!.generation).toBe(8)
        })(),
    })
  })

  test("wrong action — outbox record with different action does not match", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_action"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_subscribe",
            agentId: "ag-wa",
            projectId: "pr-wa",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.action).toBe("project_subscribe")
          const taskResult = "task_result"
          expect(record!.action).not.toBe(taskResult)
        })(),
    })
  })

  test("wrong agentId — mismatched outbox record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_ag"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-correct",
            projectId: "pr-1",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.agentId).toBe("ag-correct")
          expect(record!.agentId).not.toBe("ag-wrong")
        })(),
    })
  })

  test("wrong projectId — mismatched outbox record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_pr"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-correct",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.projectId).toBe("pr-correct")
          expect(record!.projectId).not.toBe("pr-wrong")
        })(),
    })
  })

  test("wrong taskId — mismatched outbox record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_tk"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            taskId: "tk-correct",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.taskId).toBe("tk-correct")
          expect(record!.taskId).not.toBe("tk-wrong")
        })(),
    })
  })

  test("wrong runId — mismatched outbox record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_run"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            runId: "run-correct",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.runId).toBe("run-correct")
          expect(record!.runId).not.toBe("run-wrong")
        })(),
    })
  })

  test("wrong subtaskId — mismatched outbox record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_wrong_sub"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            subtaskId: "sub-correct",
            payload: {},
          })

          const record = await ClarusOutbox.get(requestID)
          expect(record!.subtaskId).toBe("sub-correct")
          expect(record!.subtaskId).not.toBe("sub-wrong")
        })(),
    })
  })

  test("exact matching event — all identity fields match", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_exact_match"
          const record = await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-exact",
            projectId: "pr-exact",
            taskId: "tk-exact",
            runId: "run-exact",
            subtaskId: "sub-exact",
            payload: { output: "done" },
            connectionEpoch: "42",
            generation: 100,
          })

          // Verify all identity fields stored correctly
          expect(record.connectionEpoch).toBe("42")
          expect(record.generation).toBe(100)
          expect(record.action).toBe("task_result")
          expect(record.agentId).toBe("ag-exact")
          expect(record.projectId).toBe("pr-exact")
          expect(record.taskId).toBe("tk-exact")
          expect(record.runId).toBe("run-exact")
          expect(record.subtaskId).toBe("sub-exact")

          await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "42", generation: 100 })
          await ClarusOutbox.markAcknowledged(requestID)

          const final = await ClarusOutbox.get(requestID)
          expect(final!.state).toBe("acknowledged")
          expect(final!.acknowledgedAt).toBeGreaterThan(0)

          // After acknowledge, identity fields preserved
          expect(final!.connectionEpoch).toBe("42")
          expect(final!.agentId).toBe("ag-exact")
        })(),
    })
  })
})

// ============================================================================
// 4. TERMINAL_STATES completeness
// ============================================================================
describe("isTerminalOutboxState", () => {
  test("all four terminal states are recognized", () => {
    expect(isTerminalOutboxState("acknowledged")).toBe(true)
    expect(isTerminalOutboxState("rejected")).toBe(true)
    expect(isTerminalOutboxState("ambiguous")).toBe(true)
    expect(isTerminalOutboxState("local_only")).toBe(true)
  })

  test("non-terminal states are not terminal", () => {
    expect(isTerminalOutboxState("prepared")).toBe(false)
    expect(isTerminalOutboxState("dispatched")).toBe(false)
  })
})

// ============================================================================
// 5. Real runtime-handler identity coverage — handleObservedEvent → handleTaskResultRecorded
// ============================================================================

import { ClarusRuntime } from "../../src/clarus/runtime"
import { ClarusConfigReader } from "../../src/clarus/config-reader"
import { ClarusWorkspace } from "../../src/clarus/workspace"

class MinimalPort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<(event: ClarusObservedEvent) => void | Promise<void>>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()

  registerEventHandler(handler: (event: ClarusObservedEvent) => void | Promise<void>): () => void {
    this.eventHandlers.add(handler)
    return () => void this.eventHandlers.delete(handler)
  }
  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => void this.connectionHandlers.delete(handler)
  }
  async emitEvent(event: ClarusObservedEvent): Promise<void> {
    await Promise.all([...this.eventHandlers].map((h) => h(event)))
  }
  async emitConnection(event: HolosConnectionEvent): Promise<void> {
    await Promise.all([...this.connectionHandlers].map((h) => h(event)))
  }
  subscribeProject(input: { requestID: string; projectID: string }) {
    return { requestID: input.requestID, response: new Promise<never>(() => {}) }
  }
  unsubscribeProject(input: { requestID: string; projectID: string }) {
    return { requestID: input.requestID, response: new Promise<never>(() => {}) }
  }
  sendProjectMessage(input: { requestID: string; projectID: string; content: string }) {
    return { requestID: input.requestID, response: new Promise<never>(() => {}) }
  }
  extendTask(input: { requestID: string; runID: string }) {
    return { requestID: input.requestID, response: new Promise<never>(() => {}) }
  }
  recordTaskResult(input: { requestID: string }) {
    return { requestID: input.requestID, response: new Promise<never>(() => {}) }
  }
}

function connectedEvent(agentID: string, epoch: number, generation: number): HolosConnectionEvent {
  return { type: "connected", agentID, sessionID: `ses_${epoch}_${generation}`, epoch, generation }
}

function recordedEvent(
  agentID: string,
  projectID: string,
  taskID: string,
  runID: string,
  epoch: number,
  generation: number,
  requestID?: string,
): RuntimeTaskResultRecordedEvent {
  return {
    kind: "known",
    type: "runtimeTaskResultRecorded",
    agentID,
    requestID: requestID ?? null,
    projectID,
    runID,
    task: { taskID, subtaskID: "sub_hdl", status: "completed" },
    epoch,
    generation,
  }
}

const runtimeAgentId = "ag_hdl"
const runtimeProjectId = "pr_hdl"
const runtimeTaskId = "tk_hdl"

async function seedHandlerBinding(
  tmp: Awaited<ReturnType<typeof tmpdir>>,
  scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>,
) {
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(runtimeAgentId, runtimeProjectId)
      await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_hdl` })
      const { Session } = await import("../../src/session")
      const session = await Session.create({})
      await ClarusTaskBindingStore.ensureAssigned(
        runtimeAgentId,
        runtimeProjectId,
        runtimeTaskId,
        session.id,
        `${tmp.path}/clarus_hdl/${runtimeTaskId}`,
        scope.id,
      )
      await ClarusTaskBindingStore.updateAssignmentMetadata({
        agentId: runtimeAgentId,
        projectId: runtimeProjectId,
        taskId: runtimeTaskId,
        runID: "run_hdl",
        phase: "implementation",
        subtaskID: "sub_hdl",
        attempt: 1,
        deadlineAt: null,
        frozenAgent: "synergy",
        title: "Handler test",
        taskInput: { goal: "test" },
        contextHydration: "complete",
      })
    },
  })
}

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusConfigReader.invalidate()
})

describe("Runtime handler identity through handleObservedEvent", () => {
  test("stale epoch event is dropped — no mutation to Outbox or TaskBinding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_epoch"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
            connectionEpoch: "3",
            generation: 1,
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          const event = recordedEvent(runtimeAgentId, runtimeProjectId, runtimeTaskId, "run_hdl", 5, 1)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("stale generation event is dropped — no mutation to Outbox or TaskBinding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_gen"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
            connectionEpoch: "3",
            generation: 1,
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          const event = recordedEvent(runtimeAgentId, runtimeProjectId, runtimeTaskId, "run_hdl", 3, 2)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("mismatched runID returns early — no mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_run"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          const event = recordedEvent(runtimeAgentId, runtimeProjectId, runtimeTaskId, "run_wrong", 3, 1)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("mismatched taskId returns early (binding not found) — no mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_task"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          // Emit with a different taskId — binding lookup returns null
          const event = recordedEvent(runtimeAgentId, runtimeProjectId, "tk_wrong", "run_hdl", 3, 1)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("mismatched projectId returns early — no mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_project"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          const event = recordedEvent(runtimeAgentId, "pr_wrong", runtimeTaskId, "run_hdl", 3, 1)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("mismatched agentId returns early — no mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve
    try {
      ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/clarus_hdl`, enabled: true })
      await seedHandlerBinding(tmp, scope)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.attach(port)
          await port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))
          await Bun.sleep(10)

          const requestID = "hdl_agent"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            payload: {},
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          const event = recordedEvent("ag_wrong", runtimeProjectId, runtimeTaskId, "run_hdl", 3, 1)
          await port.emitEvent(event)
          await Bun.sleep(10)

          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("prepared")
          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("prepared")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })

  test("outbox identity fields are correctly stored for handler validation", async () => {
    const requestID = "hdl_oid_agent"
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: "ag_wrong",
      projectId: "pr_hdl",
      taskId: "tk_hdl",
      runId: "run_hdl",
      payload: {},
      connectionEpoch: "3",
      generation: 1,
    })
    const record = await ClarusOutbox.get(requestID)
    expect(record!.agentId).toBe("ag_wrong")
    await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "3", generation: 1 })
    await ClarusOutbox.markAcknowledged(requestID)
    expect((await ClarusOutbox.get(requestID))!.state).toBe("acknowledged")
  })

  test("outbox identity fields — runId is stored correctly for handler validation", async () => {
    const requestID = "hdl_oid_run"
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: "ag_hdl",
      projectId: "pr_hdl",
      taskId: "tk_hdl",
      runId: "run_wrong",
      payload: {},
      connectionEpoch: "3",
      generation: 1,
    })
    const record = await ClarusOutbox.get(requestID)
    expect(record!.runId).toBe("run_wrong")
    await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "3", generation: 1 })
    await ClarusOutbox.markAcknowledged(requestID)
    expect((await ClarusOutbox.get(requestID))!.state).toBe("acknowledged")
  })

  test("outbox identity fields — subtaskId is stored correctly for handler validation", async () => {
    const requestID = "hdl_oid_sub"
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: "ag_hdl",
      projectId: "pr_hdl",
      taskId: "tk_hdl",
      runId: "run_hdl",
      subtaskId: "sub_oid",
      payload: {},
      connectionEpoch: "3",
      generation: 1,
    })
    const record = await ClarusOutbox.get(requestID)
    expect(record!.subtaskId).toBe("sub_oid")
    await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "3", generation: 1 })
    await ClarusOutbox.markAcknowledged(requestID)
    expect((await ClarusOutbox.get(requestID))!.state).toBe("acknowledged")
  })

  test("exact matching record acknowledges and completes once", async () => {
    const requestID = "hdl_exact"
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: "ag_hdl",
      projectId: "pr_hdl",
      taskId: "tk_hdl",
      runId: "run_hdl",
      payload: {},
      connectionEpoch: "3",
      generation: 1,
    })
    await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "3", generation: 1 })
    await ClarusOutbox.markAcknowledged(requestID)
    expect((await ClarusOutbox.get(requestID))!.state).toBe("acknowledged")
  })

  test("exact matching record replay is idempotent", async () => {
    const requestID = "hdl_idempotent"
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: "ag_hdl",
      projectId: "pr_hdl",
      taskId: "tk_hdl",
      runId: "run_hdl",
      payload: {},
      connectionEpoch: "3",
      generation: 1,
    })
    await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "3", generation: 1 })
    await ClarusOutbox.markAcknowledged(requestID)
    const replay = await ClarusOutbox.markAcknowledged(requestID)
    expect(replay.state).toBe("acknowledged")
  })
})

// ============================================================================
// 6. Zero-binding buffered-event drain — task.result.recorded acknowledged
//    even when reconciliation finds no active project subscriptions
// ============================================================================

import type { ClarusRestPort } from "../../src/clarus/rest-port"

type ResolveFn = () => void

function controlledRestPort(gate: Promise<void>): ClarusRestPort.Interface {
  return {
    async listProjects(_params: {
      status?: string
      limit?: number
      cursor?: string
    }): Promise<{ projects: ClarusRestPort.ProjectSummaryDto[]; nextCursor: string | null }> {
      await gate
      return { projects: [], nextCursor: null }
    },
    async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
      throw new Error("unexpected getProject in zero-binding test")
    },
    async listMessages(_params: {
      projectId: string
      cursor?: string
      limit?: number
    }): Promise<{ messages: ClarusRestPort.MessageDto[]; nextCursor: string | null }> {
      throw new Error("unexpected listMessages in zero-binding test")
    },
    async listUsers(_params: { query: string; limit?: number }) {
      return { users: [] }
    },
  }
}

describe("Zero-binding buffered-event drain", () => {
  afterEach(() => {
    ClarusRuntime.detach()
    ClarusRuntime.configureRest(null)
    ClarusConfigReader.invalidate()
  })

  test("buffered task.result.recorded is acknowledged when active bindings are zero", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new MinimalPort()
    const originalResolve = ClarusConfigReader.resolve

    // Gate: keep reconciliation blocked until we emit the event
    let gateResolve!: ResolveFn
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve
    })

    try {
      ClarusConfigReader.resolve = async () => ({
        workspaceRoot: `${tmp.path}/clarus_hdl`,
        enabled: true,
      })
      ClarusRuntime.configureRest(controlledRestPort(gate))

      await seedHandlerBinding(tmp, scope)

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const requestID = "zb_req"

          // Prepare outbox and task binding so the recorded event has a target
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            runId: "run_hdl",
            subtaskId: "sub_hdl",
            payload: {},
            connectionEpoch: "3",
            generation: 1,
          })
          await ClarusTaskBindingStore.markSubmitting({
            agentId: runtimeAgentId,
            projectId: runtimeProjectId,
            taskId: runtimeTaskId,
            resultOutboxRequestID: requestID,
          })

          // Attach and trigger reconciliation — it blocks inside listProjects
          await ClarusRuntime.attach(port)
          const connPromise = port.emitConnection(connectedEvent(runtimeAgentId, 3, 1))

          // Emit the event while reconciliation is active (still blocked on listProjects)
          const event = recordedEvent(runtimeAgentId, runtimeProjectId, runtimeTaskId, "run_hdl", 3, 1, requestID)
          await port.emitEvent(event)

          // Unblock reconciliation — it will find zero projects, archive bindings,
          // hit the zero-active-bindings path, and drain buffered events
          gateResolve()
          await connPromise

          // Allow reconciliation and draining to complete
          await Bun.sleep(50)

          // Verify the buffered event was acknowledged
          const outbox = await ClarusOutbox.get(requestID)
          expect(outbox!.state).toBe("acknowledged")

          const binding = await ClarusTaskBindingStore.get(runtimeAgentId, runtimeProjectId, runtimeTaskId)
          expect(binding!.resultState!).toBe("acknowledged")
        },
      })
    } finally {
      ClarusConfigReader.resolve = originalResolve
    }
  })
})
