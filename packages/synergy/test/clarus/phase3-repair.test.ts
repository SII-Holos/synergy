import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import type { ClarusRestPort } from "../../src/clarus/rest-port"
import { ClarusRuntime } from "../../src/clarus/runtime"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusOutbox } from "../../src/clarus/outbox"
import { ClarusWorkspace } from "../../src/clarus/workspace"
import { ClarusConfigReader } from "../../src/clarus/config-reader"
import { ClarusRestClient } from "../../src/clarus/rest-client"
import { validateHolosEndpoint } from "../../src/holos/security"
import { Envelope } from "../../src/holos/envelope"
import { HolosProfile } from "../../src/holos/profile"
import { Holos, ClarusConfig } from "../../src/config/schema"
import type {
  ClarusAgentTunnelPort,
  ClarusObservedEvent,
  ClarusRequestResult,
  RuntimeTaskAssignedEvent,
} from "../../src/clarus/agent-tunnel-port"
import type { NativeMessage, NativeTunnelPort } from "../../src/holos/native"
import { createClarusAgentTunnelAdapter } from "../../src/holos/clarus"
import type { HolosConnectionEvent } from "../../src/holos/native"

const agentId = "repair_agent"
const projectId = "repair_project"
const taskId = "repair_task"

class IdlePort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<(event: ClarusObservedEvent) => void | Promise<void>>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  resultInputs: Array<{ requestID: string }> = []
  resultResponse: Promise<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>> = new Promise(() => {})

  registerEventHandler(handler: (event: ClarusObservedEvent) => void | Promise<void>): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async emitEvent(event: ClarusObservedEvent): Promise<void> {
    await Promise.all([...this.eventHandlers].map((handler) => handler(event)))
  }

  async emitConnection(event: HolosConnectionEvent): Promise<void> {
    await Promise.all([...this.connectionHandlers].map((handler) => handler(event)))
  }

  subscribeProject(input: { requestID: string; projectID: string }): ClarusRequestResult<never> {
    return { requestID: input.requestID, response: new Promise(() => {}) }
  }

  unsubscribeProject(input: { requestID: string; projectID: string }): ClarusRequestResult<never> {
    return { requestID: input.requestID, response: new Promise(() => {}) }
  }

  sendProjectMessage(input: { requestID: string; projectID: string; content: string }): ClarusRequestResult<never> {
    return { requestID: input.requestID, response: new Promise(() => {}) }
  }

  extendTask(input: { requestID: string; runID: string }): ClarusRequestResult<never> {
    return { requestID: input.requestID, response: new Promise(() => {}) }
  }

  recordTaskResult(input: {
    requestID: string
  }): ClarusRequestResult<Extract<ClarusObservedEvent, { type: "runtimeTaskResultRecorded" }>> {
    this.resultInputs.push({ requestID: input.requestID })
    return { requestID: input.requestID, response: this.resultResponse }
  }
}

function connected(generation = 1): HolosConnectionEvent {
  return { type: "connected", agentID: agentId, sessionID: `session-${generation}`, generation, epoch: generation }
}

async function seedTask(scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>) {
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(agentId, projectId)
      const session = await ClarusTaskBindingStore.ensureAssigned(
        agentId,
        projectId,
        taskId,
        "ses_task_repair",
        "/tmp/ignored-by-home-scope",
        "project-scope",
      )
      await ClarusTaskBindingStore.updateAssignmentMetadata({
        agentId,
        projectId,
        taskId,
        runID: "run_repair",
        phase: "implementation",
        subtaskID: "subtask_repair",
        attempt: 1,
        deadlineAt: null,
        frozenAgent: "synergy",
        title: "Repair task",
        taskInput: { goal: "repair" },
        contextHydration: "complete",
      })
      return session
    },
  })
}

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusConfigReader.invalidate()
})

describe("Clarus Phase 3 security boundaries", () => {
  test("accepts secure endpoints and explicit loopback exceptions only", () => {
    expect(validateHolosEndpoint("https://api.example.test", "api").toString()).toBe("https://api.example.test/")
    expect(validateHolosEndpoint("wss://api.example.test", "ws").protocol).toBe("wss:")
    expect(validateHolosEndpoint("http://localhost:8787", "api").protocol).toBe("http:")
    expect(validateHolosEndpoint("ws://127.0.0.1:8787", "ws").protocol).toBe("ws:")
    expect(() => validateHolosEndpoint("http://api.example.test", "api")).toThrow()
    expect(() => validateHolosEndpoint("ws://api.example.test", "ws")).toThrow()
    expect(() => validateHolosEndpoint("https://user:secret@api.example.test", "api")).toThrow()
    expect(() => validateHolosEndpoint("not a URL", "api")).toThrow()
  })

  test("Clarus REST client reads rotating credentials and identity for every request", async () => {
    const requests: Request[] = []
    let credential = { agentId: "agent-a", agentSecret: "secret-a" }
    const client = new ClarusRestClient({
      apiUrl: "https://api.example.test",
      credentials: async () => credential,
      fetch: async (request: RequestInfo | URL, _init?: RequestInit) => {
        requests.push(new Request(request))
        return Response.json({ code: 0, data: { items: [], next_cursor: null } })
      },
    })

    await client.listProjects({})
    credential = { agentId: "agent-b", agentSecret: "secret-b" }
    await client.listProjects({})

    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer secret-a",
      "Bearer secret-b",
    ])
    expect(requests.map((request) => request.headers.get("x-agent-id"))).toEqual(["agent-a", "agent-b"])
  })

  test("Clarus REST client rejects cross-origin redirects and oversized bodies", async () => {
    let calls = 0
    const client = new ClarusRestClient({
      apiUrl: "https://api.example.test",
      credentials: async () => ({ agentId, agentSecret: "secret" }),
      fetch: async (_request: RequestInfo | URL, init?: RequestInit) => {
        calls++
        expect(init?.redirect).toBe("error")
        return new Response("x".repeat(1024 * 1024 + 1), { status: 200 })
      },
      maxResponseBytes: 1024,
    })

    await expect(client.listProjects({})).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe("Clarus Phase 3 result state machine", () => {
  test("result dispatch returns without acknowledging; only exact recorded event acknowledges", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new IdlePort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedTask(scope)
        await ClarusRuntime.attach(port)
        await port.emitConnection(connected())
        const requestID = "result_repair"
        const result = await ClarusRuntime.recordTaskResult({
          requestID,
          agentId,
          projectId,
          runID: "run_repair",
          taskID: taskId,
          subtaskID: "subtask_repair",
          success: true,
          output: "done",
          artifacts: [],
          evidenceRefs: [],
          notaryRefs: [],
          payload: {},
        })
        expect(result).toEqual({ requestID })
        expect((await ClarusOutbox.get(requestID))?.state).toBe("dispatched")
      },
    })
  })

  test("terminal outbox states are immutable and local-only cannot be rewritten", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusOutbox.preallocate({
          requestID: "immutable_repair",
          action: "task_result",
          agentId,
          projectId,
          taskId,
          runId: "run_repair",
          subtaskId: "subtask_repair",
          payload: {},
        })
        await ClarusOutbox.markRejected("immutable_repair", "REJECTED", "redacted")
        await expect(ClarusOutbox.markAcknowledged("immutable_repair")).rejects.toMatchObject({
          code: "CLARUS_OUTBOX_TERMINAL",
        })
        expect((await ClarusOutbox.get("immutable_repair"))?.state).toBe("rejected")
      },
    })
  })

  test("task session creation always uses Home Scope", async () => {
    const tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()
    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus` })
        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        const session = await getOrCreateTaskSession({ agentId, projectId, taskId, scope: projectScope })
        expect((session.scope as Scope).type).toBe("home")
        expect((session.scope as Scope).id).toBe(Scope.home().id)
      },
    })
  })
})

describe("Clarus Phase 3 bounded inputs", () => {
  test("rejects traversal request IDs before StoragePath construction", async () => {
    await expect(
      ClarusOutbox.preallocate({
        requestID: "../escape",
        action: "task_result",
        agentId,
        projectId,
        taskId,
        payload: {},
      }),
    ).rejects.toThrow()
    expect(StoragePath.clarusOutbox("safe_request")).toEqual(["clarus", "outbox", "safe_request"])
  })
})

test("rejects oversized native frames before parsing", () => {
  expect(Envelope.parse(JSON.stringify({ type: "clarus.future", payload: "x".repeat(2 * 1024 * 1024) }))).toBeNull()
})

test("preserves connection epoch and generation on semantic Clarus events", async () => {
  const nativeObservers = new Set<(message: NativeMessage) => void | Promise<void>>()
  const tunnel: NativeTunnelPort = {
    registerNativeObserver(handler) {
      nativeObservers.add(handler)
      return () => nativeObservers.delete(handler)
    },
    registerConnectionObserver() {
      return () => {}
    },
    sendNativeRequest(input) {
      return { requestID: input.requestID, response: Promise.reject(new Error("not used")) }
    },
  }
  const adapter = createClarusAgentTunnelAdapter(tunnel)
  let observed: ClarusObservedEvent | undefined
  adapter.registerEventHandler((event) => {
    observed = event
  })
  const message: NativeMessage = {
    type: "clarus.project.system.event",
    requestID: null,
    meta: {},
    payload: { project_id: projectId, event_type: "current-agent" },
    caller: null,
    agentID: agentId,
    sessionID: "session-3",
    generation: 3,
    epoch: 7,
  }
  await Promise.all([...nativeObservers].map((handler) => handler(message)))
  expect(observed).toMatchObject({ type: "projectSystemEvent", agentID: agentId, generation: 3, epoch: 7 })
})

test("runtime ignores stale-generation events after a connection replacement", async () => {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const port = new IdlePort()
  const staleEvent: RuntimeTaskAssignedEvent & { epoch: number; generation: number } = {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: agentId,
    requestID: null,
    projectID: projectId,
    runID: "stale_run",
    taskID: taskId,
    phase: "stale",
    subtaskID: "stale_subtask",
    attempt: 99,
    deadlineAt: null,
    goal: "stale",
    epoch: 6,
    generation: 1,
  }
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await seedTask(scope)
      await ClarusRuntime.attach(port)
      await port.emitConnection(connected(2))
      await Bun.sleep(20)
      await port.emitEvent(staleEvent)
      await Bun.sleep(20)
    },
  })
  expect((await ClarusTaskBindingStore.get(agentId, projectId, taskId))?.runID).toBe("run_repair")
})

test("attach resolves asynchronous config and disables work when configured off", async () => {
  const originalResolve = ClarusConfigReader.resolve
  const tmp = await tmpdir({ git: true })
  const port = new IdlePort()
  try {
    ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/custom-root`, enabled: true })
    await ClarusRuntime.attach(port)
    await Bun.sleep(20)
    expect(ClarusWorkspace.resolveWorkspacePath({ agentId, projectId })).toStartWith(`${tmp.path}/custom-root`)
    ClarusRuntime.detach()
    ClarusConfigReader.resolve = async () => ({ workspaceRoot: `${tmp.path}/disabled-root`, enabled: false })
    await ClarusRuntime.attach(port)
    await Bun.sleep(20)
    expect(ClarusRuntime.isAttached()).toBe(false)
  } finally {
    ClarusConfigReader.resolve = originalResolve
  }
})

test("a successful result response remains dispatched until its recorded event", async () => {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const port = new IdlePort()
  const responseTaskId = "repair_task_response_only"
  port.resultResponse = Promise.resolve({
    kind: "known",
    type: "runtimeTaskResultRecorded",
    agentID: agentId,
    requestID: "response_only",
    projectID: projectId,
    runID: "run_response",
    epoch: 1,
    generation: 1,
    task: { taskID: responseTaskId, subtaskID: "subtask_response", status: "submitted" },
  })
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(agentId, projectId)
      await ClarusTaskBindingStore.ensureAssigned(
        agentId,
        projectId,
        responseTaskId,
        "ses_response_only",
        "/tmp/ignored-by-home-scope",
        "scope-response",
      )
      await ClarusTaskBindingStore.updateAssignmentMetadata({
        agentId,
        projectId,
        taskId: responseTaskId,
        runID: "run_response",
        phase: "implementation",
        subtaskID: "subtask_response",
        attempt: 1,
        deadlineAt: null,
        frozenAgent: "synergy",
        title: "Response task",
        taskInput: {},
        contextHydration: "complete",
      })
      await ClarusRuntime.attach(port)
      await port.emitConnection(connected())
      await ClarusTaskBindingStore.markProcessing(agentId, projectId, responseTaskId)
      await ClarusRuntime.recordTaskResult({
        requestID: "response_only",
        agentId,
        projectId,
        runID: "run_response",
        taskID: responseTaskId,
        subtaskID: "subtask_response",
        success: true,
        output: "done",
        artifacts: [],
        evidenceRefs: [],
        notaryRefs: [],
        payload: {},
      })
    },
  })
  expect((await ClarusOutbox.get("response_only"))?.state).toBe("dispatched")
})

test("Holos schema rejects insecure external endpoints", () => {
  expect(Holos.safeParse({ apiUrl: "http://api.example.test", wsUrl: "wss://api.example.test" }).success).toBe(false)
  expect(Holos.safeParse({ apiUrl: "https://api.example.test", wsUrl: "ws://localhost:8787" }).success).toBe(true)
})

describe("ClarusConfig schema validation", () => {
  test("accepts empty object", () => {
    expect(ClarusConfig.safeParse({}).success).toBe(true)
  })

  test("accepts valid HTTPS origin apiUrl", () => {
    expect(ClarusConfig.safeParse({ apiUrl: "https://clarus-pre.holosai.io" }).success).toBe(true)
  })

  test("accepts loopback HTTP apiUrl", () => {
    expect(ClarusConfig.safeParse({ apiUrl: "http://localhost:8787" }).success).toBe(true)
    expect(ClarusConfig.safeParse({ apiUrl: "http://127.0.0.1:8787" }).success).toBe(true)
  })

  test("rejects non-origin apiUrl (has pathname)", () => {
    const result = ClarusConfig.safeParse({ apiUrl: "https://clarus-pre.holosai.io/api/v1/holos/clarus" })
    expect(result.success).toBe(false)
  })

  test("rejects insecure external HTTP apiUrl", () => {
    const result = ClarusConfig.safeParse({ apiUrl: "http://api.example.test" })
    expect(result.success).toBe(false)
  })

  test("rejects ws protocol apiUrl", () => {
    const result = ClarusConfig.safeParse({ apiUrl: "wss://api.example.test" })
    expect(result.success).toBe(false)
  })

  test("rejects junk string as apiUrl", () => {
    const result = ClarusConfig.safeParse({ apiUrl: "not-a-url" })
    expect(result.success).toBe(false)
  })
})

test("bounds reconciliation event buffering by count and records overflow recovery", async () => {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const port = new IdlePort()
  let releaseDiscovery: (() => void) | undefined
  const discoveryBlocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve
  })
  const rest: ClarusRestPort.Interface = {
    listProjects: async () => {
      await discoveryBlocked
      return { projects: [], nextCursor: null }
    },
    getProject: async () => {
      throw new Error("not used")
    },
    listMessages: async () => ({ messages: [], nextCursor: null }),
    listUsers: async () => ({ users: [] }),
  }

  try {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.emitConnection(connected(1))
        await Promise.all(
          Array.from({ length: 600 }, (_, index) =>
            port.emitEvent({
              kind: "unknown",
              sourceType: `clarus.test.${index}`,
              agentID: agentId,
              requestID: null,
              epoch: 1,
              generation: 1,
            }),
          ),
        )
        const state = await Storage.read<{ needsReconciliation?: boolean; lastError?: string }>(
          StoragePath.clarusReconciliation(agentId),
        )
        expect(state.needsReconciliation).toBe(true)
        expect(state.lastError).toBe("reconciliation event queue overflow")
      },
    })
  } finally {
    releaseDiscovery?.()
  }
})

test("rejects public result recording without the active authenticated task identity", async () => {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const port = new IdlePort()
  port.resultResponse = Promise.resolve({
    kind: "known",
    type: "runtimeTaskResultRecorded",
    agentID: agentId,
    requestID: "identity_repair",
    projectID: projectId,
    runID: "run_repair",
    epoch: 1,
    generation: 1,
    task: { taskID: taskId, subtaskID: "subtask_repair", status: "submitted" },
  })

  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusRuntime.attach(port)
      await expect(
        ClarusRuntime.recordTaskResult({
          requestID: "identity_repair",
          agentId,
          projectId,
          runID: "run_repair",
          taskID: taskId,
          subtaskID: "subtask_repair",
          success: true,
          output: "done",
          artifacts: [],
          evidenceRefs: [],
          notaryRefs: [],
          payload: {},
        }),
      ).rejects.toThrow()
    },
  })
  expect(port.resultInputs).toHaveLength(0)
  expect(await ClarusOutbox.get("identity_repair")).toBeUndefined()
})

test("rejects symlinked Clarus workspace roots and descendants", async () => {
  const tmp = await tmpdir({ git: true })
  const target = `${tmp.path}/target`
  const rootLink = `${tmp.path}/root-link`
  await fs.mkdir(target, { recursive: true })
  await fs.symlink(target, rootLink)
  ClarusWorkspace.configure({ workspaceRoot: rootLink })
  await expect(ClarusWorkspace.ensureWorkspace({ agentId, projectId })).rejects.toThrow()

  const root = `${tmp.path}/root`
  ClarusWorkspace.configure({ workspaceRoot: root })
  const workspacePath = ClarusWorkspace.resolveWorkspacePath({ agentId, projectId })
  await fs.mkdir(root, { recursive: true })
  await fs.symlink(target, path.dirname(workspacePath))
  await expect(ClarusWorkspace.ensureWorkspace({ agentId, projectId })).rejects.toThrow()
})

test("Holos profile rejects insecure credential endpoints before making a request", async () => {
  await expect(HolosProfile.getMe({ agentSecret: "secret", apiUrl: "http://external.example.test" })).rejects.toThrow()
})

test("bounds retained extension request IDs while preserving the newest IDs", async () => {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await seedTask(scope)
      for (let index = 0; index < 40; index++) {
        await ClarusTaskBindingStore.updateExtensionOutbox(agentId, projectId, taskId, `extend_${index}`)
      }
    },
  })
  const binding = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
  expect(binding?.extendOutboxRequestIDs).toHaveLength(32)
  expect(binding?.extendOutboxRequestIDs[0]).toBe("extend_8")
  expect(binding?.extendOutboxRequestIDs.at(-1)).toBe("extend_39")
})
