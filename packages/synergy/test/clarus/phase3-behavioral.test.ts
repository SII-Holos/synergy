import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SessionEvent } from "../../src/session/event"
import { SessionInbox } from "../../src/session/inbox"
import { ClarusRuntime } from "../../src/clarus/runtime"
import { Identifier } from "../../src/id/id"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusOutbox } from "../../src/clarus/outbox"
import { ClarusSubmitTaskResultTool } from "../../src/tool/clarus-submit-task-result"
import type { Tool } from "../../src/tool/tool"
import { ClarusProjectActivityStore } from "../../src/clarus/activity"
import type {
  ClarusAgentTunnelPort,
  ClarusEventHandler,
  ClarusObservedEvent,
  ClarusRequestFailure,
  ClarusRequestResult,
  ExtendTaskInput,
  RecordTaskResultInput,
  SubscribeProjectInput,
  UnsubscribeProjectInput,
  SendProjectMessageInput,
} from "../../src/clarus/agent-tunnel-port"
import type { ClarusRestPort } from "../../src/clarus/rest-port"
import type { HolosConnectionEvent } from "../../src/holos/native"
import { GlobalBus } from "../../src/bus/global"

let AGENT_ID = "agent_1"
let PROJECT_ID = "project_1"

type ProjectPage = {
  cursor?: string
  projects: ClarusRestPort.ProjectSummaryDto[]
  nextCursor: string | null
}

type MessagePage = {
  cursor?: string
  messages: ClarusRestPort.MessageDto[]
  nextCursor: string | null
}

class FakeRest implements ClarusRestPort.Interface {
  readonly projectCalls: Array<{ status?: string; limit?: number; cursor?: string }> = []
  readonly messageCalls: Array<{ projectId: string; cursor?: string; limit?: number }> = []

  constructor(
    readonly projectPages: ProjectPage[],
    readonly messagePages: Map<string, MessagePage[]> = new Map(),
  ) {}

  async listProjects(params: { status?: string; limit?: number; cursor?: string }) {
    this.projectCalls.push(params)
    const page = this.projectPages.find((candidate) => candidate.cursor === params.cursor)
    if (!page) throw new Error(`No project page for cursor ${params.cursor ?? "<start>"}`)
    return { projects: page.projects, nextCursor: page.nextCursor }
  }

  async getProject(params: { projectId: string }) {
    const project = this.projectPages
      .flatMap((page) => page.projects)
      .find((item) => item.projectId === params.projectId)
    if (!project) throw new Error(`Unknown project ${params.projectId}`)
    return project
  }

  async listMessages(params: { projectId: string; cursor?: string; limit?: number }) {
    this.messageCalls.push(params)
    const pages = this.messagePages.get(params.projectId) ?? []
    const page = pages.find((candidate) => candidate.cursor === params.cursor)
    if (!page) return { messages: [], nextCursor: null }
    const messages = params.limit === undefined ? page.messages : page.messages.slice(0, params.limit)
    return { messages, nextCursor: page.nextCursor }
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

type ScheduledEntry = {
  delayMs: number
  callback: () => void
  active: boolean
}

class FakeScheduler {
  readonly entries: ScheduledEntry[] = []

  schedule(delayMs: number, callback: () => void): Disposable {
    const entry: ScheduledEntry = { delayMs, callback, active: true }
    this.entries.push(entry)
    return {
      [Symbol.dispose]: () => {
        entry.active = false
      },
    }
  }

  runNext(predicate: (entry: ScheduledEntry) => boolean = () => true): ScheduledEntry {
    const entry = this.entries.find((candidate) => candidate.active && predicate(candidate))
    if (!entry) throw new Error("No matching scheduled callback")
    entry.active = false
    entry.callback()
    return entry
  }
}

class FakeClarusPort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<ClarusEventHandler>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  readonly subscribeInputs: SubscribeProjectInput[] = []
  readonly extendInputs: ExtendTaskInput[] = []
  readonly resultInputs: RecordTaskResultInput[] = []
  failSubscriptions = false
  resultFailure: "sync_rejected" | "rejected" | "ambiguous" | null = null
  resultResponse:
    | Promise<{
        kind: "known"
        type: "runtimeTaskResultRecorded"
        agentID: string
        requestID: string | null
        projectID: string
        runID: string
        task: { taskID: string; subtaskID: string; status: string }
        epoch: number
        generation: number
      }>
    | undefined
  extensionDeadlineAt: string | null = null

  registerEventHandler(handler: ClarusEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async connect(agentID = AGENT_ID, generation = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "connected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch: 1,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  async disconnect(agentID = AGENT_ID, generation = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "disconnected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch: 1,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  async emit(event: ClarusObservedEvent): Promise<void> {
    for (const handler of this.eventHandlers) await handler(event)
  }

  subscribeProject(
    input: SubscribeProjectInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "projectSubscribed" }>> {
    this.subscribeInputs.push(input)
    if (this.failSubscriptions) throw new Error("subscription unavailable")
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "projectSubscribed",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: input.projectID,
        epoch: 1,
        generation: 1,
      }),
    }
  }

  unsubscribeProject(
    input: UnsubscribeProjectInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "projectUnsubscribed" }>> {
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "projectUnsubscribed",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: input.projectID,
        epoch: 1,
        generation: 1,
      }),
    }
  }

  sendProjectMessage(
    input: SendProjectMessageInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "projectMessageCreated" }>> {
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "projectMessageCreated",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: input.projectID,
        epoch: 1,
        generation: 1,
        message: { messageID: `message-${input.requestID}`, senderID: AGENT_ID, content: input.content },
      }),
    }
  }

  extendTask(
    input: ExtendTaskInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskExtended" }>> {
    this.extendInputs.push(input)
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "runtimeTaskExtended",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: PROJECT_ID,
        runID: input.runID,
        epoch: 1,
        generation: 1,
        task: { taskID: input.taskID ?? "task_1", deadlineAt: this.extensionDeadlineAt, status: "running" },
      }),
    }
  }

  recordTaskResult(
    input: RecordTaskResultInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>> {
    this.resultInputs.push(input)
    if (this.resultFailure === "sync_rejected") {
      throw {
        disposition: "rejected",
        requestID: input.requestID,
        code: "RUNTIME_RUN_NOT_FOUND",
        message: "Runtime run was not found",
      } satisfies ClarusRequestFailure
    }
    if (this.resultFailure === "rejected") {
      const response = Promise.reject({
        disposition: "rejected",
        requestID: input.requestID,
        code: "RUNTIME_RUN_NOT_FOUND",
        message: "Runtime run was not found",
      } satisfies ClarusRequestFailure)
      void response.catch(() => {})
      return { requestID: input.requestID, response }
    }
    if (this.resultFailure === "ambiguous") {
      const response = Promise.reject({
        disposition: "ambiguous",
        requestID: input.requestID,
        reason: "timeout",
        message: "Timed out after dispatch",
      } satisfies ClarusRequestFailure)
      void response.catch(() => {})
      return { requestID: input.requestID, response }
    }
    return {
      requestID: input.requestID,
      response:
        this.resultResponse ??
        Promise.resolve({
          kind: "known",
          type: "runtimeTaskResultRecorded",
          agentID: AGENT_ID,
          requestID: input.requestID,
          projectID: PROJECT_ID,
          runID: input.runID,
          epoch: 1,
          generation: 1,
          task: { taskID: input.taskID ?? "task_1", subtaskID: input.subtaskID, status: "submitted" },
        }),
    }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
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

function taskAssignedEvent(
  input?: Partial<Extract<ClarusObservedEvent, { type: "runtimeTaskAssigned" }>>,
): Extract<ClarusObservedEvent, { type: "runtimeTaskAssigned" }> {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: AGENT_ID,
    requestID: null,
    projectID: PROJECT_ID,
    runID: "run_1",
    taskID: "task_1",
    phase: "implementation",
    subtaskID: "subtask_1",
    attempt: 1,
    epoch: 1,
    generation: 1,
    deadlineAt: null,
    ...input,
  }
}

async function prepareProject(scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>): Promise<void> {
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
      await ClarusBindingStore.reconcileBinding({
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        projectName: "Project One",
        projectStatus: "active",
        primaryAgent: "synergy",
      })
    },
  })
}

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `agent_${suffix}`
  PROJECT_ID = `project_${suffix}`
})

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
})

describe("Clarus Phase 3 discovery and reconciliation", () => {
  test("paginates REST discovery, creates bindings, and archives missing projects", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new FakeRest([
      { projects: [project(PROJECT_ID)], nextCursor: "next" },
      { cursor: "next", projects: [project(`${PROJECT_ID}_2`)], nextCursor: null },
    ])
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, "missing_project")
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const first = await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID)
          const second = await ClarusBindingStore.readV3(AGENT_ID, `${PROJECT_ID}_2`)
          const missing = await ClarusBindingStore.readV3(AGENT_ID, "missing_project")
          const reconciliation = await Storage.read<{ needsReconciliation?: boolean; lastReconciledAt?: number }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return (
            first?.lifecycle === "active" &&
            second?.lifecycle === "active" &&
            missing?.lifecycle === "archived" &&
            reconciliation.needsReconciliation === false &&
            typeof reconciliation.lastReconciledAt === "number"
          )
        })
      },
    })

    expect(rest.projectCalls.map((call) => call.cursor)).toEqual([undefined, "next"])
    expect(port.subscribeInputs).toHaveLength(2)
    const reconciliation = await Storage.read(StoragePath.clarusReconciliation(AGENT_ID))
    expect(reconciliation).toMatchObject({ needsReconciliation: false })
  })

  test("retains reconciliation failure state when subscription fails", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new FakeRest([{ projects: [project(PROJECT_ID)], nextCursor: null }])
    const port = new FakeClarusPort()
    port.failSubscriptions = true

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean; lastError?: string }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation === true && state.lastError === "subscription unavailable"
        })
      },
    })

    const state = await Storage.read<{ needsReconciliation: boolean; lastError?: string }>(
      StoragePath.clarusReconciliation(AGENT_ID),
    )
    expect(state.needsReconciliation).toBe(true)
    expect(state.lastError).toContain("subscription unavailable")
  })

  test("enforces the aggregate backfill page budget and persists the continuation cursor", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const pages: MessagePage[] = Array.from({ length: 201 }, (_, index) => ({
      cursor: index === 0 ? undefined : `cursor_${index}`,
      messages: [
        {
          messageId: `message_${index}`,
          content: `message ${index}`,
        },
      ],
      nextCursor: index < 200 ? `cursor_${index + 1}` : null,
    }))
    const rest = new FakeRest([{ projects: [project(PROJECT_ID)], nextCursor: null }], new Map([[PROJECT_ID, pages]]))
    const port = new FakeClarusPort()

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
          const activityCount = (await ClarusProjectActivityStore.listByProject(AGENT_ID, PROJECT_ID)).length
          return state.needsReconciliation === true && activityCount === 200
        })
      },
    })

    expect(await ClarusProjectActivityStore.listByProject(AGENT_ID, PROJECT_ID)).toHaveLength(200)
    expect((await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID))?.messageCursor).toBe("cursor_200")
    expect(rest.messageCalls).toHaveLength(200)
    expect(rest.messageCalls.every((call) => (call.limit ?? 0) <= 50)).toBe(true)
  })
})

describe("Clarus Phase 3 assignment, deadline, and events", () => {
  test("REST backfill routes a live dispatched task through canonical assignment ingestion", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const taskId = "backfilled_task"
    const rest = new FakeRest(
      [{ projects: [project(PROJECT_ID)], nextCursor: null }],
      new Map([
        [
          PROJECT_ID,
          [
            {
              messages: [
                {
                  messageId: "remote_dispatch",
                  messageType: "system",
                  content: "Task dispatched",
                  createdAt: new Date().toISOString(),
                  metadata: {
                    event_type: "runtime.task.dispatched",
                    assigned_agent_id: AGENT_ID,
                    payload: {
                      project_id: PROJECT_ID,
                      run_id: "backfill_run",
                      task_id: taskId,
                      phase: "implementation",
                      subtask_id: "backfill_subtask",
                      attempt: 1,
                      deadline_at: null,
                      goal: "Recover this task",
                      context: { snapshot: { state: { ready: true } } },
                      input_refs: [],
                    },
                  },
                },
              ],
              nextCursor: null,
            },
          ],
        ],
      ]),
    )
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, taskId))?.assignmentState === "enqueued",
        )
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, taskId)
    expect(binding).toMatchObject({
      runID: "backfill_run",
      subtaskID: "backfill_subtask",
      title: "Recover this task",
      contextHydration: "complete",
      assignmentState: "enqueued",
      taskInput: {
        goal: "Recover this task",
        context: { snapshot: { state: { ready: true } } },
        input_refs: [],
      },
    })
    expect(await SessionInbox.list(binding!.sessionID)).toHaveLength(1)
  })

  test("REST backfill rejects tasks assigned to another agent", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const taskId = "cross_agent_task"
    const rest = new FakeRest(
      [{ projects: [project(PROJECT_ID)], nextCursor: null }],
      new Map([
        [
          PROJECT_ID,
          [
            {
              messages: [
                {
                  messageId: "cross_agent_dispatch",
                  metadata: {
                    event_type: "runtime.task.dispatched",
                    assigned_agent_id: "another_agent",
                    payload: {
                      project_id: PROJECT_ID,
                      run_id: "cross_agent_run",
                      task_id: taskId,
                      phase: "implementation",
                      subtask_id: "cross_agent_subtask",
                      attempt: 1,
                      deadline_at: null,
                    },
                  },
                },
              ],
              nextCursor: null,
            },
          ],
        ],
      ]),
    )
    const port = new FakeClarusPort()

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
          return state.needsReconciliation === false
        })
      },
    })

    expect(await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, taskId)).toBeUndefined()
  })

  test("live and backfilled assignment delivery is idempotent", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        const assignment = taskAssignedEvent({ goal: "Idempotent task", context: { snapshot: true } })
        await port.emit(assignment)
        await port.emit(assignment)
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
    expect(await SessionInbox.list(binding!.sessionID)).toHaveLength(1)
  })

  test("assignment stores frozen agent and derived task metadata, then enqueues exactly once", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(
          taskAssignedEvent({
            goal: "Implement the assigned feature",
            instructions: "Use the current architecture",
            input: { input_key: "input_value" },
            context: { current_task: "Fallback title", snapshot: true },
            taskInput: { explicit: true },
          }),
        )
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
    expect(binding).toMatchObject({
      frozenAgent: "synergy",
      title: "Implement the assigned feature",
      contextHydration: "complete",
      assignmentState: "enqueued",
      taskInput: {
        explicit: true,
        goal: "Implement the assigned feature",
        instructions: "Use the current architecture",
        input: { input_key: "input_value" },
      },
    })
    const items = await SessionInbox.list(binding!.sessionID)
    expect(items).toHaveLength(1)
    expect(items[0]?.message?.agent).toBe("synergy")
    const assignmentText = items[0]?.message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    expect(assignmentText).toContain('skill(name="clarus-agent-participation")')
    expect(assignmentText).toContain("clarus_submit_task_result")
    expect(assignmentText).toContain("Agent must actively submit")
    expect(assignmentText).toContain("Synergy does not monitor or auto-submit")
    expect(assignmentText).toContain("success: false")
    expect(assignmentText).toContain("Task ID: task_1")
    expect(assignmentText).toContain("Phase: implementation")
    expect(assignmentText).toContain("Attempt: 1")
    expect(assignmentText).toContain("Goal: Implement the assigned feature")
    expect(assignmentText).toContain("Deadline: none")
    expect(items[0]?.message?.metadata).toMatchObject({
      clarusAssignment: { frozenAgent: "synergy", runID: "run_1" },
    })
    expect(items[0]?.message?.tools).toEqual({ clarus_submit_task_result: true, skill: true })
  })

  test("deadline guard dispatches an extension and records its acknowledged outbox", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const scheduler = new FakeScheduler()
    const port = new FakeClarusPort()
    port.extensionDeadlineAt = new Date(Date.now() + 30_000).toISOString()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(
          taskAssignedEvent({
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            context: { snapshot: true },
            taskInput: { explicit: true },
          }),
        )
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        scheduler.runNext((entry) => entry.delayMs < 60_000)
        await waitFor(async () => {
          const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
          if (binding?.deadlineAt !== port.extensionDeadlineAt) return false
          const requestID = binding.extendOutboxRequestIDs.at(-1)
          return requestID !== undefined && (await ClarusOutbox.get(requestID))?.state === "acknowledged"
        })
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
    expect(binding?.extendOutboxRequestIDs).toHaveLength(1)
    expect(binding?.deadlineAt).toBe(port.extensionDeadlineAt)
    const outbox = await ClarusOutbox.get(binding!.extendOutboxRequestIDs[0]!)
    expect(outbox?.state).toBe("acknowledged")
  })

  test("system archive makes a project inactive and unknown agent join triggers discovery", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new FakeRest([{ projects: [project("joined_project")], nextCursor: null }])
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit({
          kind: "known",
          type: "projectSystemEvent",
          agentID: AGENT_ID,
          requestID: null,
          projectID: PROJECT_ID,
          epoch: 1,
          generation: 1,
          eventType: "archive",
        })
        await waitFor(async () => (await ClarusBindingStore.readV3(AGENT_ID, PROJECT_ID))?.lifecycle === "archived")
        await port.emit({
          kind: "known",
          type: "projectSystemEvent",
          agentID: AGENT_ID,
          requestID: null,
          projectID: "joined_project",
          epoch: 1,
          generation: 1,
          eventType: "agent_joined",
        })
        await waitFor(async () => (await ClarusBindingStore.readV3(AGENT_ID, "joined_project"))?.lifecycle === "active")
        await port.emit({
          kind: "unknown",
          sourceType: "clarus.future.event",
          agentID: AGENT_ID,
          requestID: null,
          epoch: 1,
          generation: 1,
        })
        await port.emit({
          kind: "invalid",
          sourceType: "clarus.invalid",
          agentID: AGENT_ID,
          requestID: null,
          issues: [{ path: ["payload"], message: "invalid" }],
          epoch: 1,
          generation: 1,
        })
      },
    })

    expect(rest.projectCalls.length).toBeGreaterThan(0)
  })
})

describe("Clarus Phase 3 result and recovery", () => {
  test("session idle and error never submit or monitor the Agent result", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(
          taskAssignedEvent({
            goal: "Agent-owned result",
            context: { snapshot: true },
            taskInput: { explicit: true },
          }),
        )
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
        GlobalBus.emit("event", {
          payload: { type: SessionEvent.Idle.type, properties: { sessionID: binding!.sessionID } },
        })
        GlobalBus.emit("event", {
          payload: { type: SessionEvent.Error.type, properties: { sessionID: binding!.sessionID } },
        })
        await Bun.sleep(20)
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
    expect(port.resultInputs).toHaveLength(0)
    expect(binding?.status).toBe("running")
    expect(binding?.resultState).toBe("idle")
    expect(binding?.resultOutboxRequestID).toBeUndefined()
  })

  test("Agent tool submission transitions from running through submitting to submitted", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    port.resultResponse = new Promise(() => {})

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(
          taskAssignedEvent({
            goal: "Submit through the Agent tool",
            context: { snapshot: true },
            taskInput: { explicit: true },
          }),
        )
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
        const tool = await ClarusSubmitTaskResultTool.init()
        expect(Object.keys(tool.parameters.shape)).toEqual([
          "success",
          "output",
          "artifacts",
          "evidence_refs",
          "notary_refs",
          "error",
        ])
        const ctx: Tool.Context = {
          sessionID: binding!.sessionID,
          messageID: Identifier.ascending("message"),
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        const execution = tool.execute(
          {
            success: true,
            output: "Result ready",
            artifacts: [
              {
                artifact_id: "artifact_1",
                name: "result.md",
                description: "Reusable result",
                parts: [
                  {
                    type: "text",
                    format: "markdown",
                    role: "specialist_output",
                    content_kind: "report",
                    name: "result.md",
                    content: "# Result\n\nComplete reusable body.",
                  },
                ],
              },
            ],
            evidence_refs: ["artifact_1"],
          },
          ctx,
        )
        const result = await Promise.race([execution, Bun.sleep(50).then(() => null)])
        expect(result).not.toBeNull()
        if (!result) throw new Error("Clarus result tool waited for the recorded response")
        expect(result.title).toBe("Clarus task result submitted")
        expect(port.resultInputs).toHaveLength(1)
        expect(port.resultInputs[0]).toMatchObject({
          runID: "run_1",
          taskID: "task_1",
          subtaskID: "subtask_1",
          success: true,
          timeoutMs: 120_000,
        })
        const submitting = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
        expect(submitting?.status).toBe("submitting")
        expect(submitting?.resultState).toBe("prepared")
        expect(submitting?.resultOutboxRequestID).toBe(result.metadata.requestID)
        expect((await ClarusOutbox.get(result.metadata.requestID))?.state).toBe("dispatched")

        await port.emit({
          kind: "known",
          type: "runtimeTaskResultRecorded",
          agentID: AGENT_ID,
          requestID: result.metadata.requestID,
          projectID: PROJECT_ID,
          runID: "run_1",
          epoch: 1,
          generation: 1,
          task: { taskID: "task_1", subtaskID: "subtask_1", status: "submitted" },
        })
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "submitted",
        )
      },
    })

    const submitted = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
    expect(submitted?.status).toBe("submitted")
    expect(submitted?.resultState).toBe("acknowledged")
    expect((await ClarusOutbox.get(submitted!.resultOutboxRequestID!))?.state).toBe("acknowledged")
  })
  test("Synergy settles rejected and ambiguous result responses after the Agent tool returns", async () => {
    for (const failure of ["rejected", "ambiguous"] as const) {
      const suffix = `${Date.now()}_${failure}_${Math.random().toString(36).slice(2, 8)}`
      AGENT_ID = `agent_${suffix}`
      PROJECT_ID = `project_${suffix}`
      const tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const port = new FakeClarusPort()
      port.resultFailure = failure

      await ScopeContext.provide({
        scope,
        fn: async () => {
          await prepareProject(scope)
          await ClarusRuntime.attach(port)
          await port.connect()
          await port.emit(taskAssignedEvent({ context: { snapshot: true }, taskInput: { explicit: true } }))
          await waitFor(
            async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
          )
          const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
          const tool = await ClarusSubmitTaskResultTool.init()
          const ctx: Tool.Context = {
            sessionID: binding!.sessionID,
            messageID: Identifier.ascending("message"),
            agent: "synergy",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          }

          const result = await tool.execute({ success: true, output: "Result ready" }, ctx)
          expect(result.title).toBe("Clarus task result submitted")
          const requestID = port.resultInputs[0]!.requestID
          expect(String(result.metadata.requestID)).toBe(requestID)
          await waitFor(async () => (await ClarusOutbox.get(requestID))?.state === failure)
          const reverted = await ClarusTaskBindingStore.get(binding!.agentId, binding!.projectId, binding!.taskId)
          expect(reverted).toMatchObject({ status: "needs_attention", resultState: "idle" })
          expect(reverted?.resultOutboxRequestID).toBeUndefined()
        },
      })
      ClarusRuntime.detach()
    }
  })

  test("Agent tool preserves synchronous rejected result failure semantics", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    port.resultFailure = "sync_rejected"

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(taskAssignedEvent({ context: { snapshot: true }, taskInput: { explicit: true } }))
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
        const tool = await ClarusSubmitTaskResultTool.init()
        const ctx: Tool.Context = {
          sessionID: binding!.sessionID,
          messageID: Identifier.ascending("message"),
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }

        await expect(tool.execute({ success: true, output: "Result ready" }, ctx)).rejects.toMatchObject({
          code: "RUNTIME_RUN_NOT_FOUND",
          disposition: "rejected",
          message: expect.stringContaining("Do not retry unless Clarus reassigns the task"),
        })
      },
    })
  })

  test("Agent tool rejects an already-aborted submission before dispatch", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        await ClarusRuntime.attach(port)
        await port.connect()
        await port.emit(taskAssignedEvent({ context: { snapshot: true }, taskInput: { explicit: true } }))
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1")
        const tool = await ClarusSubmitTaskResultTool.init()
        const abort = new AbortController()
        abort.abort()
        const ctx: Tool.Context = {
          sessionID: binding!.sessionID,
          messageID: Identifier.ascending("message"),
          agent: "synergy",
          abort: abort.signal,
          metadata() {},
          async ask() {},
        }

        await expect(tool.execute({ success: true, output: "Result ready" }, ctx)).rejects.toMatchObject({
          code: "ABORTED",
          disposition: "rejected",
          message: expect.stringContaining("The result was not dispatched"),
        })
        expect(port.resultInputs).toHaveLength(0)
      },
    })
  })
})

describe("Clarus Phase 3 lifecycle reset", () => {
  test("reattach keeps one tunnel listener and detach clears session listeners and timers", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const scheduler = new FakeScheduler()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await prepareProject(scope)
        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await ClarusRuntime.attach(port)
        await port.connect()
        expect(port.eventHandlers.size).toBe(1)
        expect(port.connectionHandlers.size).toBe(1)
        await port.emit(taskAssignedEvent({ deadlineAt: new Date(Date.now() + 10_000).toISOString() }))
        await waitFor(
          async () => (await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_1"))?.status === "running",
        )
        ClarusRuntime.detach()
        expect(ClarusRuntime.isAttached()).toBe(false)
        expect(port.eventHandlers.size).toBe(0)
        expect(port.connectionHandlers.size).toBe(0)
        expect(scheduler.entries.filter((entry) => entry.active)).toHaveLength(0)
      },
    })
  })

  test("connection events publish navigation updates on Home Scope without a current scope", async () => {
    const port = new FakeClarusPort()
    const received: Array<{ directory?: string; payload: { type?: string } }> = []
    const handler = (event: { directory?: string; payload: { type?: string } }) => received.push(event)

    await ClarusRuntime.attach(port)
    GlobalBus.on("event", handler)
    try {
      await port.connect()
      await waitFor(() =>
        received.some((event) => event.directory === "home" && event.payload.type === "clarus.navigation.updated"),
      )
    } finally {
      GlobalBus.off("event", handler)
    }
  })
})
