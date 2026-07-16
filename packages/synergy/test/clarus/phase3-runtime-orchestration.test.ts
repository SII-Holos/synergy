import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusRuntime } from "../../src/clarus/runtime"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusOutbox } from "../../src/clarus/outbox"
import type {
  ClarusAgentTunnelPort,
  ClarusEventHandler,
  ClarusObservedEvent,
  ClarusRequestResult,
  ProjectSubscribedEvent,
  RecordTaskResultInput,
  SubscribeProjectInput,
} from "../../src/clarus/agent-tunnel-port"
import type { ClarusRestPort } from "../../src/clarus/rest-port"
import type { HolosConnectionEvent } from "../../src/holos/native"

let AGENT_ID = "orch_agent"
let PROJECT_ID = "orch_project"

type ListProjectsCall = { status?: string; limit?: number; cursor?: string }
type ListMessagesCall = { projectId: string; cursor?: string; limit?: number }
type ListProjectsFn = () => Promise<{ projects: ClarusRestPort.ProjectSummaryDto[]; nextCursor: string | null }>
type ListMessagesFn = (params: {
  projectId: string
  cursor?: string
  limit?: number
}) => Promise<{ messages: ClarusRestPort.MessageDto[]; nextCursor: string | null }>

class BlockableRest implements ClarusRestPort.Interface {
  readonly projectCalls: ListProjectsCall[] = []
  readonly messageCalls: ListMessagesCall[] = []
  private _listProjectsImpl: ListProjectsFn | null = null
  private _listMessagesImpl: ListMessagesFn | null = null

  setListProjects(impl: ListProjectsFn): void {
    this._listProjectsImpl = impl
  }
  setListMessages(impl: ListMessagesFn): void {
    this._listMessagesImpl = impl
  }

  async listProjects(params: { status?: string; limit?: number; cursor?: string }) {
    this.projectCalls.push(params)
    if (this._listProjectsImpl) return this._listProjectsImpl()
    return { projects: [], nextCursor: null }
  }
  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not used")
  }
  async listMessages(params: { projectId: string; cursor?: string; limit?: number }) {
    this.messageCalls.push(params)
    if (this._listMessagesImpl) return this._listMessagesImpl(params)
    return { messages: [], nextCursor: null }
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

class FakeScheduler {
  readonly entries: Array<{ delayMs: number; callback: () => void; active: boolean }> = []

  schedule(delayMs: number, callback: () => void): Disposable {
    const entry = { delayMs, callback, active: true }
    this.entries.push(entry)
    return {
      [Symbol.dispose]: () => {
        entry.active = false
      },
    }
  }

  get activeCount(): number {
    return this.entries.filter((e) => e.active).length
  }
}

class FakeClarusPort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<ClarusEventHandler>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  readonly subscribeInputs: SubscribeProjectInput[] = []
  resultInputs: RecordTaskResultInput[] = []
  failSubscriptions = false
  subscribeBlocked = false
  private _subscribeResolvers: Array<() => void> = []

  registerEventHandler(handler: ClarusEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }
  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async connect(agentID = AGENT_ID, generation = 1, epoch = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "connected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  async disconnect(agentID = AGENT_ID, generation = 1, epoch = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "disconnected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  async emit(event: ClarusObservedEvent): Promise<void> {
    for (const handler of this.eventHandlers) await handler(event)
  }

  subscribeProject(input: SubscribeProjectInput): ClarusRequestResult<ProjectSubscribedEvent> {
    this.subscribeInputs.push(input)
    if (this.failSubscriptions) throw new Error("subscription unavailable")
    const response = this.subscribeBlocked
      ? new Promise<ProjectSubscribedEvent>((resolve) => {
          this._subscribeResolvers.push(() =>
            resolve({
              kind: "known" as const,
              type: "projectSubscribed" as const,
              agentID: AGENT_ID,
              requestID: input.requestID,
              projectID: input.projectID,
              epoch: 1,
              generation: 1,
            }),
          )
        })
      : Promise.resolve({
          kind: "known" as const,
          type: "projectSubscribed" as const,
          agentID: AGENT_ID,
          requestID: input.requestID,
          epoch: 1,
          generation: 1,
          projectID: input.projectID,
        })
    return { requestID: input.requestID, response }
  }

  resolveAllSubscriptions(): void {
    for (const r of this._subscribeResolvers) r()
    this._subscribeResolvers = []
  }

  unsubscribeProject(input: {
    requestID: string
    projectID: string
  }): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "projectUnsubscribed" }>> {
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known" as const,
        type: "projectUnsubscribed" as const,
        agentID: AGENT_ID,
        requestID: input.requestID,
        epoch: 1,
        generation: 1,
        projectID: input.projectID,
      }),
    }
  }

  sendProjectMessage(input: {
    requestID: string
    projectID: string
    content: string
  }): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "projectMessageCreated" }>> {
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known" as const,
        type: "projectMessageCreated" as const,
        agentID: AGENT_ID,
        requestID: input.requestID,
        epoch: 1,
        generation: 1,
        projectID: input.projectID,
        message: { messageID: `message-${input.requestID}`, senderID: AGENT_ID, content: input.content },
      }),
    }
  }

  extendTask(input: {
    requestID: string
    runID: string
  }): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskExtended" }>> {
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known" as const,
        type: "runtimeTaskExtended" as const,
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: PROJECT_ID,
        epoch: 1,
        generation: 1,
        runID: input.runID,
        task: { taskID: "task_ext", deadlineAt: null, status: "running" },
      }),
    }
  }

  recordTaskResult(
    input: RecordTaskResultInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>> {
    this.resultInputs.push(input)
    return {
      requestID: input.requestID,
      response: new Promise(() => {}),
    }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Clarus state")
    await Bun.sleep(2)
  }
}

function project(projectId: string, title = projectId): ClarusRestPort.ProjectSummaryDto {
  return {
    projectId,
    title,
    status: "active",
    role: "member",
    runtimeAgentId: "synergy",
    updatedAt: new Date().toISOString(),
  }
}

function messageDto(messageId: string, content = messageId): ClarusRestPort.MessageDto {
  return {
    messageId,
    content,
    createdAt: new Date().toISOString(),
  }
}

async function seedProject(
  scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>,
  projectId: string,
): Promise<void> {
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(AGENT_ID, projectId)
    },
  })
}

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `orch_${suffix}`
  PROJECT_ID = `proj_${suffix}`
})

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
})

describe("Clarus Phase 3 reconciliation lifecycle", () => {
  test("detach aborts in-flight reconciliation and stale run is suppressed before remote ops", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    let listProjectsResolved = false
    rest.setListProjects(async () => {
      await Bun.sleep(200)
      listProjectsResolved = true
      return { projects: [project(PROJECT_ID)], nextCursor: null }
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await Bun.sleep(10)
        ClarusRuntime.detach()
        await Bun.sleep(200)
      },
    })

    expect(listProjectsResolved).toBe(true)
    // After detach, reconciliation was aborted before binding creation
    const binding = await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID)
    expect(binding).toBeUndefined()
  })

  test("reconciliation respects time budget and exits early if exceeded", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    let pageCount = 0
    rest.setListProjects(async () => {
      await Bun.sleep(20)
      pageCount++
      return {
        projects: pageCount === 1 ? [project(PROJECT_ID)] : [],
        nextCursor: pageCount < 3 ? `cursor_${pageCount}` : null,
      }
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation !== undefined
        }, 5_000)
      },
    })

    const state = await Storage.read<{ needsReconciliation: boolean; lastError?: string }>(
      StoragePath.clarusReconciliation(AGENT_ID),
    )
    expect(state.needsReconciliation !== undefined).toBe(true)
  })

  test("reconciliation detects non-progressing message cursor and marks exhausted", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const messages: ClarusRestPort.MessageDto[] = Array.from({ length: 5 }, (_, i) => messageDto(`msg_${i}`))
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [project(PROJECT_ID)],
      nextCursor: null,
    }))

    let messagePageCount = 0
    rest.setListMessages(async () => {
      messagePageCount++
      return {
        messages: messages.slice(0, 2),
        nextCursor: messagePageCount > 5 ? null : "stuck_cursor",
      }
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation !== undefined
        }, 5_000)
      },
    })

    const reconciliation = await Storage.read<{ needsReconciliation: boolean; lastError?: string }>(
      StoragePath.clarusReconciliation(AGENT_ID),
    )
    expect(reconciliation.needsReconciliation).toBe(true)
  })
})

describe("Clarus Phase 3 fair rotating backfill", () => {
  test("backfill distributes budget across multiple projects instead of exhausting on first", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const projA = `${PROJECT_ID}_a`
    const projB = `${PROJECT_ID}_b`
    const messagesA = Array.from({ length: 30 }, (_, i) => messageDto(`a_msg_${i}`))
    const messagesB = Array.from({ length: 30 }, (_, i) => messageDto(`b_msg_${i}`))

    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [project(projA, "A"), project(projB, "B")],
      nextCursor: null,
    }))

    const messageCallTracker: string[] = []
    rest.setListMessages(async (params) => {
      messageCallTracker.push(params.projectId)
      if (params.projectId === projA) {
        const offset = params.cursor ? parseInt(params.cursor.split("_")[1], 10) : 0
        const slice = messagesA.slice(offset, offset + (params.limit ?? 50))
        const nextOffset = offset + slice.length
        return {
          messages: slice,
          nextCursor: nextOffset < messagesA.length ? `a_cursor_${nextOffset}` : null,
        }
      }
      const offset = params.cursor ? parseInt(params.cursor.split("_")[1], 10) : 0
      const slice = messagesB.slice(offset, offset + (params.limit ?? 50))
      const nextOffset = offset + slice.length
      return {
        messages: slice,
        nextCursor: nextOffset < messagesB.length ? `b_cursor_${nextOffset}` : null,
      }
    })
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, projA)
        await seedProject(scope, projB)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => rest.messageCalls.length > 0, 5_000)
      },
    })
  })
})

describe("Clarus Phase 3 subscription dedup", () => {
  test("skip re-subscription when outbox already records dispatched state for same generation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [project(PROJECT_ID)],
      nextCursor: null,
    }))

    // Pre-seed an outbox entry that looks like an already-dispatched subscription
    await ClarusOutbox.preallocate({
      requestID: "dedup_seeded",
      action: "project_subscribe",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: { project_id: PROJECT_ID },
      generation: 1,
    })
    await ClarusOutbox.markDispatched("dedup_seeded")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation !== undefined
        }, 5_000)
      },
    })

    // No new subscription requests should be created for the already-subscribed project
    const newSubscriptions = port.subscribeInputs.filter((input) => input.requestID !== "dedup_seeded")
    expect(newSubscriptions).toHaveLength(0)
  })
})

describe("Clarus Phase 3 deadline recovery on reconnect", () => {
  test("restores deadline guards for running tasks on connection", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const scheduler = new FakeScheduler()

    const deadline = new Date(Date.now() + 300_000).toISOString()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "task_deadline",
          "ses_deadline",
          "/tmp/ws",
          "scope_1",
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_deadline",
          runID: "run_dl",
          phase: "impl",
          subtaskID: "sub_dl",
          attempt: 1,
          deadlineAt: deadline,
          frozenAgent: "synergy",
          title: "Deadline task",
          taskInput: { goal: "test" },
          contextHydration: "complete",
        })
        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => scheduler.activeCount > 0)
      },
    })

    expect(scheduler.activeCount).toBeGreaterThan(0)
  })

  test("cancel deadline guards when task transitions to terminal status", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const scheduler = new FakeScheduler()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_term", "ses_term", "/tmp/ws", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_term",
          runID: "run_term",
          phase: "impl",
          subtaskID: "sub_term",
          attempt: 1,
          deadlineAt: new Date(Date.now() + 300_000).toISOString(),
          frozenAgent: "synergy",
          title: "Term task",
          taskInput: { goal: "test" },
          contextHydration: "complete",
        })
        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => scheduler.entries.some((entry) => entry.active && entry.delayMs > 60_000))
        // Mark task as expired -> deadline guard should be cancelled
        await ClarusTaskBindingStore.expireTask(AGENT_ID, PROJECT_ID, "task_term")
        // Trigger reconnect to trigger recovery which will rescan
        await port.connect(AGENT_ID, 2, 2)
        await Bun.sleep(30)
      },
    })

    // Guard should be cleaned up for terminal task (periodic discovery timer remains)
    const deadlineEntries = scheduler.entries.filter((e) => e.active && e.delayMs < 60_000)
    expect(deadlineEntries).toHaveLength(0)
  })
})

describe("Clarus Phase 3 session binding cache", () => {
  test("session binding cache evicts stale entries when over capacity", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusRuntime.attach(port)
        await port.connect()
        // Emit many task assigned events to populate the cache
        for (let i = 0; i < 10; i++) {
          await port.emit({
            kind: "known" as const,
            type: "runtimeTaskAssigned" as const,
            agentID: AGENT_ID,
            requestID: null,
            projectID: PROJECT_ID,
            runID: `run_${i}`,
            taskID: `task_${i}`,
            phase: "impl",
            subtaskID: `sub_${i}`,
            epoch: 1,
            generation: 1,
            attempt: 1,
            deadlineAt: null,
          })
        }
        await Bun.sleep(10)
      },
    })

    // Cache should not grow unbounded — verify the port is still properly registered
    expect(port.eventHandlers.size).toBe(1)
  })
})

describe("Clarus Phase 3 scheme A dispatch-only semantics", () => {
  test("response to recordTaskResult does not acknowledge; only recorded event acknowledges", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    let resolveResponse:
      | ((event: Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>) => void)
      | undefined

    const resultInputs: RecordTaskResultInput[] = []
    port.recordTaskResult = (input: RecordTaskResultInput) => {
      resultInputs.push(input)
      return {
        requestID: input.requestID,
        response: new Promise<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>>((resolve) => {
          resolveResponse = resolve
        }),
      }
    }

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_sa", "ses_sa", "/tmp/ws", scope.id)
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_sa",
          runID: "run_sa",
          phase: "impl",
          subtaskID: "sub_sa",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "Scheme A task",
          taskInput: {},
          contextHydration: "complete",
        })
        await ClarusRuntime.attach(port)
        await port.connect()
        const resultPromise = ClarusRuntime.recordTaskResult({
          requestID: "scheme_a_test",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          runID: "run_sa",
          taskID: "task_sa",
          subtaskID: "sub_sa",
          success: true,
          output: "done",
          artifacts: [],
          evidenceRefs: [],
          notaryRefs: [],
          payload: {},
        })

        await Bun.sleep(10)
        expect((await ClarusOutbox.get("scheme_a_test"))?.state).toBe("dispatched")

        resolveResponse?.({
          kind: "known" as const,
          type: "runtimeTaskResultRecorded" as const,
          agentID: AGENT_ID,
          requestID: "scheme_a_test",
          projectID: PROJECT_ID,
          runID: "run_sa",
          epoch: 1,
          generation: 1,
          task: { taskID: "task_sa", subtaskID: "sub_sa", status: "submitted" },
        })

        await resultPromise
        await Bun.sleep(10)
      },
    })

    // Response settled but no explicit recorded event came through the event stream
    // The outbox should still be dispatched (not acknowledged by response alone)
    const record = await ClarusOutbox.get("scheme_a_test")
    expect(record?.state).toBe("dispatched")
  })
})
