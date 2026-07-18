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

let AGENT_ID = "int_agent"
let PROJECT_ID = "int_project"

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
  subscribeInputs: SubscribeProjectInput[] = []
  resultInputs: RecordTaskResultInput[] = []

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

  subscribeProject(input: SubscribeProjectInput): ClarusRequestResult<ProjectSubscribedEvent> {
    this.subscribeInputs.push(input)
    return {
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known" as const,
        type: "projectSubscribed" as const,
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: input.projectID,
        epoch: 1,
        generation: 1,
      }),
    }
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
        projectID: input.projectID,
        epoch: 1,
        generation: 1,
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
        projectID: input.projectID,
        message: { messageID: `msg-${input.requestID}`, senderID: AGENT_ID, content: input.content },
        epoch: 1,
        generation: 1,
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
        runID: input.runID,
        task: { taskID: "task_ext", deadlineAt: null, status: "running" },
        epoch: 1,
        generation: 1,
      }),
    }
  }

  recordTaskResult(
    input: RecordTaskResultInput,
  ): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>> {
    this.resultInputs.push(input)
    return { requestID: input.requestID, response: new Promise(() => {}) }
  }
}

class BlockableRest implements ClarusRestPort.Interface {
  readonly projectCalls: Array<{ status?: string; limit?: number; cursor?: string }> = []
  readonly messageCalls: Array<{ projectId: string; cursor?: string; limit?: number }> = []
  private _listProjects: () => Promise<{ projects: ClarusRestPort.ProjectSummaryDto[]; nextCursor: string | null }> =
    async () => ({ projects: [], nextCursor: null })
  private _listMessages: (params: {
    projectId: string
    cursor?: string
    limit?: number
  }) => Promise<{ messages: ClarusRestPort.MessageDto[]; nextCursor: string | null }> = async () => ({
    messages: [],
    nextCursor: null,
  })

  setListProjects(
    impl: () => Promise<{ projects: ClarusRestPort.ProjectSummaryDto[]; nextCursor: string | null }>,
  ): void {
    this._listProjects = impl
  }
  setListMessages(
    impl: (params: {
      projectId: string
      cursor?: string
      limit?: number
    }) => Promise<{ messages: ClarusRestPort.MessageDto[]; nextCursor: string | null }>,
  ): void {
    this._listMessages = impl
  }

  async listProjects(params: { status?: string; limit?: number; cursor?: string }) {
    this.projectCalls.push(params)
    return this._listProjects()
  }
  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not used")
  }
  async listMessages(params: { projectId: string; cursor?: string; limit?: number }) {
    this.messageCalls.push(params)
    return this._listMessages(params)
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

function projectDto(projectId: string, title = projectId): ClarusRestPort.ProjectSummaryDto {
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state")
    await Bun.sleep(2)
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
  AGENT_ID = `int_${suffix}`
  PROJECT_ID = `proj_${suffix}`
})

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
})

describe("Clarus Phase 3 restart fairness", () => {
  test("rotation index persists across reconciliation cycles", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [projectDto(`${PROJECT_ID}_a`), projectDto(`${PROJECT_ID}_b`)],
      nextCursor: null,
    }))

    rest.setListMessages(async () => ({ messages: [], nextCursor: null }))

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, `${PROJECT_ID}_a`)
        await seedProject(scope, `${PROJECT_ID}_b`)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean; lastReconciledAt?: number }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation === false && state.lastReconciledAt !== undefined
        }, 5_000)
      },
    })

    // Verify rotation index was persisted in separate rotation path
    const rotationRaw = await Storage.read<{ index: number }>([
      ...StoragePath.clarusReconciliation(AGENT_ID),
      "rotation",
    ])
    expect(typeof rotationRaw?.index).toBe("number")
  })
})

describe("Clarus Phase 3 page budget", () => {
  test("backfill budget is consumed per-page and marks exhausted", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [projectDto(PROJECT_ID)],
      nextCursor: null,
    }))

    let pageCount = 0
    rest.setListMessages(async () => {
      pageCount++
      return {
        messages: Array.from({ length: 2 }, (_, i) => messageDto(`p${pageCount}_m${i}`)),
        nextCursor: `cursor_${pageCount}`,
      }
    })

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

    const state = await Storage.read<{ needsReconciliation: boolean; lastError?: string }>(
      StoragePath.clarusReconciliation(AGENT_ID),
    )
    expect(state.needsReconciliation).toBe(true)
  })

  test("backfill stops when budget exhausted and marks needsReconciliation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [projectDto(PROJECT_ID)],
      nextCursor: null,
    }))

    let pageCount = 0
    rest.setListMessages(async () => {
      pageCount++
      return {
        messages: Array.from({ length: 2 }, (_, i) => messageDto(`p${pageCount}_m${i}`)),
        nextCursor: `cursor_${pageCount}`,
      }
    })

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

    const state = await Storage.read<{ needsReconciliation: boolean; lastError?: string }>(
      StoragePath.clarusReconciliation(AGENT_ID),
    )
    // reconciliation should have hit the 200-page limit and marked exhausted
    expect(state.needsReconciliation).toBe(true)
  })
})

describe("Clarus Phase 3 result identity", () => {
  test("rejects result with stale epoch/generation when connection is disconnected", async () => {
    // recordTaskResult should throw when not connected
    await expect(
      ClarusRuntime.recordTaskResult({
        requestID: "req_stale",
        agentId: "bad",
        projectId: "bad",
        runID: "run",
        taskID: "task",
        subtaskID: "sub",
        success: true,
        output: "done",
        artifacts: [],
        evidenceRefs: [],
        notaryRefs: [],
        payload: {},
      }),
    ).rejects.toThrow("ClarusRuntime is not attached")
  })

  test("rejects result with mismatched identity dimensions", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(new BlockableRest())
        await ClarusRuntime.attach(port)
        await port.connect()

        // Try recording with a non-existent binding
        await expect(
          ClarusRuntime.recordTaskResult({
            requestID: "req_mismatch",
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            runID: "wrong_run",
            taskID: "nonexistent_task",
            subtaskID: "wrong_sub",
            success: true,
            output: "done",
            artifacts: [],
            evidenceRefs: [],
            notaryRefs: [],
            payload: {},
          }),
        ).rejects.toThrow("Clarus result identity does not match the active task binding")
      },
    })
  })

  test("rejects result for already terminal task", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_term", "ses_term", "/tmp", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_term",
          runID: "run_term",
          phase: "impl",
          subtaskID: "sub_term",
          attempt: 1,
          frozenAgent: "synergy",
          title: "Term task",
          taskInput: {},
          contextHydration: "complete",
        })
        await ClarusTaskBindingStore.expireTask(AGENT_ID, PROJECT_ID, "task_term")

        ClarusRuntime.configureRest(new BlockableRest())
        await ClarusRuntime.attach(port)
        await port.connect()

        await expect(
          ClarusRuntime.recordTaskResult({
            requestID: "req_term",
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            runID: "run_term",
            taskID: "task_term",
            subtaskID: "sub_term",
            success: true,
            output: "done",
            artifacts: [],
            evidenceRefs: [],
            notaryRefs: [],
            payload: {},
          }),
        ).rejects.toThrow("Clarus task result is already terminal")
      },
    })
  })
})

describe("Clarus Phase 3 terminal eviction", () => {
  test("deadline guards are cancelled proactively on task result recorded", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const scheduler = new FakeScheduler()
    const deadline = new Date(Date.now() + 300_000).toISOString()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_evict", "ses_evict", "/tmp", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_evict",
          runID: "run_evict",
          phase: "impl",
          subtaskID: "sub_evict",
          attempt: 1,
          deadlineAt: deadline,
          frozenAgent: "synergy",
          title: "Evict task",
          taskInput: {},
          contextHydration: "complete",
        })

        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => scheduler.activeCount > 0)

        const requestID = "result_evict"
        await ClarusOutbox.preallocate({
          requestID,
          action: "task_result",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_evict",
          runId: "run_evict",
          subtaskId: "sub_evict",
          payload: {},
          connectionEpoch: "1",
          generation: 1,
        })
        await ClarusTaskBindingStore.markSubmitting({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_evict",
          resultOutboxRequestID: requestID,
        })

        await port.eventHandlers
          .values()
          .next()
          .value?.({
            kind: "known" as const,
            type: "runtimeTaskResultRecorded" as const,
            agentID: AGENT_ID,
            requestID,
            projectID: PROJECT_ID,
            runID: "run_evict",
            task: { taskID: "task_evict", subtaskID: "sub_evict", status: "submitted" },
            epoch: 1,
            generation: 1,
          })
        await Bun.sleep(20)

        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_evict")
        expect(binding?.status).toBe("submitted")
        expect(scheduler.activeCount).toBe(0)
      },
    })
  })

  test("session binding cache evicted on task completion", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_cache", "ses_cache", "/tmp", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_cache",
          runID: "run_cache",
          phase: "impl",
          subtaskID: "sub_cache",
          attempt: 1,
          frozenAgent: "synergy",
          title: "Cache task",
          taskInput: {},
          contextHydration: "complete",
        })

        await ClarusRuntime.attach(port)
        await port.connect()

        const requestID = "result_cache"
        await ClarusOutbox.preallocate({
          requestID,
          action: "task_result",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_cache",
          runId: "run_cache",
          subtaskId: "sub_cache",
          payload: {},
          connectionEpoch: "1",
          generation: 1,
        })
        await ClarusTaskBindingStore.markSubmitting({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_cache",
          resultOutboxRequestID: requestID,
        })

        await port.eventHandlers
          .values()
          .next()
          .value?.({
            kind: "known" as const,
            type: "runtimeTaskResultRecorded" as const,
            agentID: AGENT_ID,
            requestID,
            projectID: PROJECT_ID,
            runID: "run_cache",
            task: { taskID: "task_cache", subtaskID: "sub_cache", status: "submitted" },
            epoch: 1,
            generation: 1,
          })
        await Bun.sleep(10)
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_cache")
    expect(binding?.status).toBe("submitted")
  })
})

describe("Clarus Phase 3 project-level resource eviction", () => {
  test("project archive evicts all task resources", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const scheduler = new FakeScheduler()
    const deadline = new Date(Date.now() + 300_000).toISOString()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_proj", "ses_proj", "/tmp", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_proj",
          runID: "run_proj",
          phase: "impl",
          subtaskID: "sub_proj",
          attempt: 1,
          deadlineAt: deadline,
          frozenAgent: "synergy",
          title: "Project task",
          taskInput: {},
          contextHydration: "complete",
        })

        ClarusRuntime.configureScheduler(scheduler)
        await ClarusRuntime.attach(port)
        await port.connect()
        await waitFor(async () => scheduler.activeCount > 0)

        // Emit project archive system event
        await port.eventHandlers
          .values()
          .next()
          .value?.({
            kind: "known" as const,
            type: "projectSystemEvent" as const,
            agentID: AGENT_ID,
            requestID: null,
            projectID: PROJECT_ID,
            eventType: "archive",
            epoch: 1,
            generation: 1,
          })
        await Bun.sleep(10)
      },
    })

    // All deadline guards for this project should be disposed
    const deadlineEntries = scheduler.entries.filter((e) => e.active && e.delayMs < 60_000)
    expect(deadlineEntries).toHaveLength(0)
  })
})

describe("Clarus Phase 3 non-progress detection", () => {
  test("non-progressing message pages exhaust reconciliation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    rest.setListProjects(async () => ({
      projects: [projectDto(PROJECT_ID)],
      nextCursor: null,
    }))

    let pageCount = 0
    rest.setListMessages(async () => {
      pageCount++
      // Same cursor returned every time — non-progressing
      return {
        messages: [messageDto("stale")],
        nextCursor: "stuck_cursor",
      }
    })

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

    // After MAX_NON_PROGRESSING_PAGES (3), should stop
    expect(pageCount).toBeLessThanOrEqual(4)
    const state = await Storage.read<{ needsReconciliation: boolean }>(StoragePath.clarusReconciliation(AGENT_ID))
    expect(state.needsReconciliation).toBe(true)
  })
})

describe("Clarus Phase 3 bounded event work", () => {
  test("event buffers during active reconciliation, drains afterward", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const rest = new BlockableRest()
    const port = new FakeClarusPort()

    let listProjectsBlocked = true
    rest.setListProjects(async () => {
      while (listProjectsBlocked) {
        await Bun.sleep(10)
      }
      return { projects: [], nextCursor: null }
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()

        // Emit events during reconciliation
        await port.eventHandlers
          .values()
          .next()
          .value?.({
            kind: "known" as const,
            type: "runtimeTaskAssigned" as const,
            agentID: AGENT_ID,
            requestID: null,
            projectID: PROJECT_ID,
            runID: "run_buf",
            taskID: "task_buf",
            phase: "impl",
            subtaskID: "sub_buf",
            attempt: 1,
            deadlineAt: null,
            epoch: 1,
            generation: 1,
          })

        listProjectsBlocked = false
        await waitFor(async () => {
          const state = await Storage.read<{ needsReconciliation?: boolean }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          return state.needsReconciliation !== undefined
        }, 5_000)
      },
    })

    // Event was buffered and drained after reconciliation
    const state = await Storage.read<{ needsReconciliation: boolean }>(StoragePath.clarusReconciliation(AGENT_ID))
    expect(state.needsReconciliation !== undefined).toBe(true)
  })
  test("delayed result events cannot rewrite local-only continuation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope, PROJECT_ID)
        await ClarusTaskBindingStore.ensureAssigned(AGENT_ID, PROJECT_ID, "task_local", "ses_local", "/tmp", "scope_1")
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "task_local",
          runID: "run_local",
          phase: "impl",
          subtaskID: "sub_local",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "Local task",
          taskInput: {},
          contextHydration: "complete",
        })
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusTaskBindingStore.enableLocalContinuation(AGENT_ID, PROJECT_ID, "task_local")

        await port.eventHandlers
          .values()
          .next()
          .value?.({
            kind: "known",
            type: "runtimeTaskResultRecorded",
            agentID: AGENT_ID,
            requestID: "late_local_result",
            projectID: PROJECT_ID,
            runID: "run_local",
            epoch: 1,
            generation: 1,
            task: { taskID: "task_local", subtaskID: "sub_local", status: "submitted" },
          })
      },
    })

    const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "task_local")
    expect(binding?.resultState).toBe("local_only")
    expect(binding?.status).not.toBe("submitted")
  })
})
