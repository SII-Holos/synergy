import { describe, expect, mock, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import type {
  ClarusAgentTunnelPort,
  ClarusObservedEvent,
  RuntimeTaskAssignedEvent,
} from "../../src/channel/provider/clarus/agent-tunnel-port"
import { ClarusProvider } from "../../src/channel/provider/clarus"
import { ClarusResultOutbox } from "../../src/channel/provider/clarus/result-outbox"
import { createClarusAgentTunnelAdapter } from "../../src/channel/provider/clarus/tunnel-adapter"
import type { Config } from "../../src/config/config"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { FakeNativeTunnelPort, taskAssignedEvent } from "./clarus-fixture"
import { ClarusDeadlineAgenda } from "../../src/channel/provider/clarus/deadline-agenda"
import { AgendaStore } from "../../src/agenda"
import { tmpdir } from "../fixture/fixture"

const AGENT_ID = "invite-accept-agent"
const AGENT_SECRET = "invite-accept-secret"

function accountConfig(apiUrl = "https://clarus-api.test"): Config.ChannelClarusAccount {
  return {
    apiUrl,
    agent: "",
    enabled: true,
  }
}

function provider(): ClarusProvider {
  return new ClarusProvider({
    auth: {
      getStoredCredential: async () => ({
        agentId: AGENT_ID,
        agentSecret: AGENT_SECRET,
        maskedSecret: "invite-••••-secret",
      }),
      getCredentialOrThrow: async () => ({
        agentId: AGENT_ID,
        agentSecret: AGENT_SECRET,
        maskedSecret: "invite-••••-secret",
      }),
    },
    runtime: {
      status: async () => ({ status: "connected" }),
      getNativeIdentity: async () => ({
        agentID: AGENT_ID,
        sessionID: "invite-accept-session",
        generation: 1,
        epoch: 1,
      }),
      getNativeTunnel: async () => new FakeNativeTunnelPort(),
    },
  })
}

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const timeoutAt = Date.now() + 1_000
  let value = await read()
  while (!ready(value) && Date.now() < timeoutAt) {
    await Bun.sleep(5)
    value = await read()
  }
  if (!ready(value)) throw new Error("Timed out waiting for Clarus invite/accept state")
  return value
}

function acceptedMembershipPayload(projectID: string) {
  const now = new Date().toISOString()
  return {
    project_id: projectID,
    membership: {
      member_id: "membership-1",
      project_id: projectID,
      actor_type: "agent",
      actor_id: AGENT_ID,
      role: "editor",
      status: "active",
      invited_at: now,
      accepted_at: now,
      invited_by_user_id: 3,
      created_at: now,
    },
  }
}

function acceptedTaskPayload(event: RuntimeTaskAssignedEvent) {
  return {
    run_id: event.runID,
    project_id: event.projectID,
    task_id: event.taskID,
    subtask_id: event.subtaskID,
    attempt: event.attempt,
    accepted_at: new Date().toISOString(),
  }
}

type TestConnection = {
  accountId: string
  config: Config.ChannelClarusAccount
  tunnel: ClarusAgentTunnelPort
  signal: AbortSignal
  host: ChannelHost.Instance
  projects: Map<string, string>
  outboundRequests: Set<string>
}

async function handleEvent(instance: ClarusProvider, connection: TestConnection, event: ClarusObservedEvent) {
  return (
    instance as unknown as {
      handleEvent(connection: TestConnection, event: ClarusObservedEvent): Promise<void>
    }
  ).handleEvent(connection, event)
}

async function countSessionsInAssignmentScope(sessionID: string) {
  const session = await Session.get(sessionID)
  return ScopeContext.provide({ scope: session.scope, fn: () => Session.list().then((list) => list.total) })
}

function testTunnel(overrides: Record<string, unknown> = {}): ClarusAgentTunnelPort {
  return {
    registerEventHandler: () => () => {},
    registerConnectionHandler: () => () => {},
    subscribeProject: (input: Parameters<ClarusAgentTunnelPort["subscribeProject"]>[0]) => ({
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
    }),
    unsubscribeProject: (input: Parameters<ClarusAgentTunnelPort["unsubscribeProject"]>[0]) => ({
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
    }),
    acceptTask: (input: Parameters<ClarusAgentTunnelPort["acceptTask"]>[0]) => ({
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "runtimeTaskAccepted",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: input.projectID,
        runID: input.runID,
        taskID: input.taskID,
        subtaskID: input.subtaskID,
        attempt: input.attempt,
        acceptedAt: new Date().toISOString(),
        epoch: 1,
        generation: 1,
      }),
    }),
    extendTask: (input: Parameters<ClarusAgentTunnelPort["extendTask"]>[0]) => ({
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "runtimeTaskExtended",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: "project",
        runID: input.runID,
        task: { taskID: input.taskID ?? "task", deadlineAt: null, status: "running" },
        epoch: 1,
        generation: 1,
      }),
    }),
    recordTaskResult: (input: Parameters<ClarusAgentTunnelPort["recordTaskResult"]>[0]) => ({
      requestID: input.requestID,
      response: Promise.resolve({
        kind: "known",
        type: "runtimeTaskResultRecorded",
        agentID: AGENT_ID,
        requestID: input.requestID,
        projectID: "project",
        runID: input.runID,
        task: { taskID: input.taskID ?? "task", subtaskID: input.subtaskID, status: "completed" },
        epoch: 1,
        generation: 1,
      }),
    }),
    ...overrides,
  } as unknown as ClarusAgentTunnelPort
}

describe("Clarus invitation acceptance readiness", () => {
  test("parses membership accepted as a known refresh hint", () => {
    const fake = new FakeNativeTunnelPort()
    const received: ClarusObservedEvent[] = []
    createClarusAgentTunnelAdapter(fake).registerEventHandler((event) => {
      received.push(event)
    })

    fake.emitEvent("clarus.project.membership.accepted", acceptedMembershipPayload("project-invited"))

    expect(received).toEqual([
      expect.objectContaining({
        kind: "known",
        type: "projectMembershipAccepted",
        agentID: "test-agent",
        projectID: "project-invited",
      }),
    ])
  })

  test("accepts every Platform membership status with nullable timestamps and integer inviter", () => {
    const fake = new FakeNativeTunnelPort()
    const received: ClarusObservedEvent[] = []
    createClarusAgentTunnelAdapter(fake).registerEventHandler((event) => {
      received.push(event)
    })

    for (const [status, invitedBy] of [
      ["pending", null],
      ["active", 3],
      ["declined", null],
    ] as const) {
      const payload = acceptedMembershipPayload(`project-platform-${status}`)
      fake.emitEvent("clarus.project.membership.accepted", {
        ...payload,
        membership: {
          ...payload.membership,
          status,
          invited_at: null,
          accepted_at: null,
          invited_by_user_id: invitedBy,
        },
      })
    }

    expect(received).toEqual([
      expect.objectContaining({
        kind: "known",
        type: "projectMembershipAccepted",
        projectID: "project-platform-pending",
      }),
      expect.objectContaining({
        kind: "known",
        type: "projectMembershipAccepted",
        projectID: "project-platform-active",
      }),
      expect.objectContaining({
        kind: "known",
        type: "projectMembershipAccepted",
        projectID: "project-platform-declined",
      }),
    ])
  })

  test("rejects membership accepted payloads missing authoritative membership fields", () => {
    const fake = new FakeNativeTunnelPort()
    const received: ClarusObservedEvent[] = []
    createClarusAgentTunnelAdapter(fake).registerEventHandler((event) => {
      received.push(event)
    })
    const payload = acceptedMembershipPayload("project-incomplete")
    delete (payload.membership as Partial<typeof payload.membership>).member_id

    fake.emitEvent("clarus.project.membership.accepted", payload)

    expect(received).toEqual([
      expect.objectContaining({
        kind: "invalid",
        sourceType: "clarus.project.membership.accepted",
        issues: expect.arrayContaining([expect.objectContaining({ path: ["membership", "member_id"] })]),
      }),
    ])
  })

  test("membership accepted triggers authoritative list, subscribe, and managed ownership", async () => {
    const fake = new FakeNativeTunnelPort()
    fake.setAgentID(AGENT_ID)
    const instance = new ClarusProvider({
      auth: {
        getStoredCredential: async () => ({
          agentId: AGENT_ID,
          agentSecret: AGENT_SECRET,
          maskedSecret: "invite-••••-secret",
        }),
        getCredentialOrThrow: async () => ({
          agentId: AGENT_ID,
          agentSecret: AGENT_SECRET,
          maskedSecret: "invite-••••-secret",
        }),
      },
      runtime: {
        status: async () => ({ status: "connected" }),
        getNativeIdentity: async () => ({
          agentID: AGENT_ID,
          sessionID: "invite-accept-session",
          generation: 1,
          epoch: 1,
        }),
        getNativeTunnel: async () => fake,
      },
    })
    const originalFetch = globalThis.fetch
    const requests: Request[] = []
    const configuredAccount = accountConfig("https://clarus-api.test/environment")
    let accepted = false
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        const status = new URL(request.url).searchParams.get("status")
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items:
                accepted && status === "active"
                  ? [{ project_id: "project-invited", title: "Invited project", status: "active" }]
                  : [],
              next_cursor: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }),
      { preconnect: originalFetch.preconnect },
    )
    const abort = new AbortController()
    const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID })

    try {
      await instance.connect({
        accountId: AGENT_ID,
        accountConfig: configuredAccount,
        channelConfig: { type: "clarus", accounts: { [AGENT_ID]: configuredAccount } },
        signal: abort.signal,
        host,
      })
      accepted = true
      fake.emitEvent("clarus.project.membership.accepted", acceptedMembershipPayload("project-invited"))

      const pending = await waitFor(
        () => [...fake.pending.values()],
        (items) => items.some((item) => item.type === "clarus.project.subscribe"),
      )
      const subscribe = pending.find((item) => item.type === "clarus.project.subscribe")!
      expect(subscribe.payload).toEqual({ project_id: "project-invited" })
      fake.fulfill(subscribe.requestID, {
        type: "clarus.project.subscribed",
        payload: { project_id: "project-invited", subscribed: true },
      })

      await waitFor(
        () =>
          ManagedProjectOwnership.find({
            channelType: "clarus",
            accountId: AGENT_ID,
            externalProjectId: "project-invited",
          }),
        (record) => record?.remoteState === "active",
      )
      expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET"])
      expect(requests.map((request) => new URL(request.url).searchParams.get("status"))).toEqual([
        "active",
        "paused",
        "active",
        "paused",
      ])
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/environment/api/v1/holos/clarus/projects",
        "/environment/api/v1/holos/clarus/projects",
        "/environment/api/v1/holos/clarus/projects",
        "/environment/api/v1/holos/clarus/projects",
      ])
    } finally {
      abort.abort()
      globalThis.fetch = originalFetch
    }
  })
  test("concurrent membership bursts share one authoritative project sync", async () => {
    const fake = new FakeNativeTunnelPort()
    fake.setAgentID(AGENT_ID)
    const instance = new ClarusProvider({
      auth: {
        getStoredCredential: async () => ({
          agentId: AGENT_ID,
          agentSecret: AGENT_SECRET,
          maskedSecret: "invite-••••-secret",
        }),
        getCredentialOrThrow: async () => ({
          agentId: AGENT_ID,
          agentSecret: AGENT_SECRET,
          maskedSecret: "invite-••••-secret",
        }),
      },
      runtime: {
        status: async () => ({ status: "connected" }),
        getNativeIdentity: async () => ({
          agentID: AGENT_ID,
          sessionID: "invite-accept-session",
          generation: 1,
          epoch: 1,
        }),
        getNativeTunnel: async () => fake,
      },
    })
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(new URL(request.url).searchParams.get("status") ?? "")
        return new Response(JSON.stringify({ code: 0, data: { items: [], next_cursor: null } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
      { preconnect: originalFetch.preconnect },
    )
    const abort = new AbortController()
    const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID })

    try {
      await instance.connect({
        accountId: AGENT_ID,
        accountConfig: accountConfig(),
        channelConfig: { type: "clarus", accounts: { [AGENT_ID]: accountConfig() } },
        signal: abort.signal,
        host,
      })
      fake.emitEvent("clarus.project.membership.accepted", acceptedMembershipPayload("project-burst-a"))
      fake.emitEvent("clarus.project.membership.accepted", acceptedMembershipPayload("project-burst-b"))

      await waitFor(
        () => requests.length,
        (count) => count === 4,
      )
      await Bun.sleep(50)
      expect(requests).toEqual(["active", "paused", "active", "paused"])
    } finally {
      abort.abort()
      globalThis.fetch = originalFetch
    }
  })
})

describe("Clarus assignment ownership recovery", () => {
  test("refreshes once and retries assignment dispatch when Project ownership appears", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID })
        const subscribeInputs: string[] = []
        const tunnel = testTunnel({
          subscribeProject: (input: { projectID: string; requestID: string }) => {
            subscribeInputs.push(input.projectID)
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
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel,
          signal: new AbortController().signal,
          host,
          projects: new Map(),
          outboundRequests: new Set(),
        }
        const originalFetch = globalThis.fetch
        const statuses: string[] = []
        globalThis.fetch = Object.assign(
          mock(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input)
            const status = new URL(request.url).searchParams.get("status") ?? ""
            statuses.push(status)
            return new Response(
              JSON.stringify({
                code: 0,
                data: {
                  items:
                    status === "active"
                      ? [{ project_id: "project-late", title: "Late project", status: "active" }]
                      : [],
                  next_cursor: null,
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }),
          { preconnect: originalFetch.preconnect },
        )
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-late",
          taskID: "task-late",
          runID: "run-late",
          subtaskID: "subtask-late",
        })

        try {
          await handleEvent(instance, connection, event)
        } finally {
          globalThis.fetch = originalFetch
        }

        expect(statuses).toEqual(["active", "paused"])
        expect(subscribeInputs).toEqual(["project-late"])
        const located = await ClarusAssignmentStore.findByIdentity({
          accountId: AGENT_ID,
          projectID: event.projectID,
          taskID: event.taskID,
        })
        expect(located?.assignment.status).toBe("running")
        expect(await Session.get(located!.assignment.sessionID)).toMatchObject({ id: located!.assignment.sessionID })
        expect(await countSessionsInAssignmentScope(located!.assignment.sessionID)).toBe(1)
        expect((await SessionInbox.list(located!.assignment.sessionID)).length).toBeGreaterThan(0)
      },
    })
  })

  test("retains the strict ownership guard after one unsuccessful refresh", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const diagnostics: ChannelHost.DiagnosticRecordInput[] = []
        const instance = provider()
        const host = ChannelHost.create({
          channelType: "clarus",
          accountId: AGENT_ID,
          onDiagnostic: (record) => {
            diagnostics.push(record)
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel: testTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map(),
          outboundRequests: new Set(),
        }
        const originalFetch = globalThis.fetch
        const statuses: string[] = []
        globalThis.fetch = Object.assign(
          mock(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input)
            statuses.push(new URL(request.url).searchParams.get("status") ?? "")
            return new Response(JSON.stringify({ code: 0, data: { items: [], next_cursor: null } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          }),
          { preconnect: originalFetch.preconnect },
        )
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-unowned",
          taskID: "task-unowned",
          runID: "run-unowned",
          subtaskID: "subtask-unowned",
          requestID: "assignment-unowned",
        })

        try {
          await expect(handleEvent(instance, connection, event)).rejects.toMatchObject({
            name: "ChannelHostProjectNotOwnedError",
            data: { externalProjectId: "project-unowned" },
          })
        } finally {
          globalThis.fetch = originalFetch
        }

        expect(statuses).toEqual(["active", "paused"])
        expect(
          await ManagedProjectOwnership.find({
            channelType: "clarus",
            accountId: AGENT_ID,
            externalProjectId: event.projectID,
          }),
        ).toBeUndefined()
        expect((await Session.list()).total).toBe(0)
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            level: "error",
            message: "Clarus assignment Project ownership unavailable after refresh",
            data: expect.objectContaining({
              refreshAttempt: 1,
              requestID: "assignment-unowned",
              errorName: "ChannelHostProjectNotOwnedError",
            }),
          }),
        )
      },
    })
  })
})

describe("Clarus task acceptance", () => {
  test("sends the exact task accept wire and parses its correlated response", async () => {
    const fake = new FakeNativeTunnelPort()
    const adapter = createClarusAgentTunnelAdapter(fake) as ReturnType<typeof createClarusAgentTunnelAdapter> & {
      acceptTask(input: {
        requestID: string
        runID: string
        projectID: string
        taskID: string
        subtaskID: string
        attempt: number
      }): { response: Promise<unknown> }
    }
    const requestID = "accept-request-1"
    const input = {
      requestID,
      runID: "run-accept",
      projectID: "project-accept",
      taskID: "task-accept",
      subtaskID: "subtask-accept",
      attempt: 2,
    }

    const { response } = adapter.acceptTask(input)
    expect(fake.pending.get(requestID)).toMatchObject({
      type: "clarus.runtime.task.accept",
      expectedResponseType: "clarus.runtime.task.accepted",
      payload: {
        run_id: "run-accept",
        project_id: "project-accept",
        task_id: "task-accept",
        subtask_id: "subtask-accept",
        attempt: 2,
      },
    })
    fake.fulfill(requestID, {
      type: "clarus.runtime.task.accepted",
      payload: {
        run_id: "run-accept",
        project_id: "project-accept",
        task_id: "task-accept",
        subtask_id: "subtask-accept",
        attempt: 2,
        accepted_at: new Date().toISOString(),
      },
    })

    await expect(response).resolves.toMatchObject({
      type: "runtimeTaskAccepted",
      requestID,
      runID: "run-accept",
      projectID: "project-accept",
      taskID: "task-accept",
      subtaskID: "subtask-accept",
      attempt: 2,
      acceptedAt: expect.any(String),
    })
  })

  test("uses a correlated acknowledgement to make exact replay a full local no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({ externalProjectId: "project-ack", name: "Accepted project", isActive: true })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-ack",
          taskID: "task-ack",
          runID: "run-ack",
          subtaskID: "subtask-ack",
          requestID: "assignment-accept-stable",
        })
        const acceptRequestIDs: string[] = []
        const tunnel = testTunnel({
          acceptTask: (input: Parameters<ClarusAgentTunnelPort["acceptTask"]>[0]) => {
            acceptRequestIDs.push(input.requestID)
            return {
              requestID: input.requestID,
              response: Promise.resolve({
                kind: "known",
                type: "runtimeTaskAccepted",
                agentID: AGENT_ID,
                requestID: input.requestID,
                projectID: input.projectID,
                runID: input.runID,
                taskID: input.taskID,
                subtaskID: input.subtaskID,
                attempt: input.attempt,
                acceptedAt: new Date().toISOString(),
                epoch: 1,
                generation: 1,
              }),
            }
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel,
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Accepted project"]]),
          outboundRequests: new Set(),
        }
        const originalRequest = SessionDrive.request
        let wakeCalls = 0
        ;(SessionDrive.request as unknown as (...args: unknown[]) => Promise<boolean>) = mock(async () => {
          wakeCalls++
          return true
        })

        try {
          await handleEvent(instance, connection, event)
          await Bun.sleep(10)
          const located = await ClarusAssignmentStore.findByIdentity({
            accountId: AGENT_ID,
            projectID: event.projectID,
            taskID: event.taskID,
          })
          const sessionID = located!.assignment.sessionID
          expect(wakeCalls).toBe(1)
          expect(await countSessionsInAssignmentScope(sessionID)).toBe(1)
          const firstInbox = await SessionInbox.list(sessionID)
          expect(firstInbox.length).toBeGreaterThan(0)

          await handleEvent(instance, connection, event)
          await Bun.sleep(10)

          expect(wakeCalls).toBe(1)
          expect(acceptRequestIDs).toEqual([String(event.requestID)])
          expect(await countSessionsInAssignmentScope(sessionID)).toBe(1)
          const replayed = await ClarusAssignmentStore.findByIdentity({
            accountId: AGENT_ID,
            projectID: event.projectID,
            taskID: event.taskID,
          })
          expect(replayed?.assignment.sessionID).toBe(sessionID)
          expect(await SessionInbox.list(sessionID)).toEqual(firstInbox)
        } finally {
          ;(SessionDrive.request as typeof SessionDrive.request) = originalRequest
        }
      },
    })
  })

  test("live pending exact replay bypasses Host dispatch and does not send accept twice", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({ externalProjectId: "project-live-pending", name: "Live pending", isActive: true })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-live-pending",
          taskID: "task-live-pending",
          runID: "run-live-pending",
          subtaskID: "subtask-live-pending",
          requestID: "assignment-live-pending",
        })
        let resolveAccept!: (
          event: Extract<ClarusObservedEvent, { kind: "known"; type: "runtimeTaskAccepted" }>,
        ) => void
        const response = new Promise<Extract<ClarusObservedEvent, { kind: "known"; type: "runtimeTaskAccepted" }>>(
          (resolve) => {
            resolveAccept = resolve
          },
        )
        const acceptRequestIDs: string[] = []
        const tunnel = testTunnel({
          acceptTask: (input: Parameters<ClarusAgentTunnelPort["acceptTask"]>[0]) => {
            acceptRequestIDs.push(input.requestID)
            return { requestID: input.requestID, response }
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel,
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Live pending"]]),
          outboundRequests: new Set(),
        }
        const originalDispatch = host.tasks.dispatch
        const originalRequest = SessionDrive.request
        let dispatchCalls = 0
        let wakeCalls = 0
        host.tasks.dispatch = mock(async (input: Parameters<typeof originalDispatch>[0]) => {
          dispatchCalls++
          return originalDispatch(input)
        }) as typeof originalDispatch
        ;(SessionDrive.request as unknown as (...args: unknown[]) => Promise<boolean>) = mock(async () => {
          wakeCalls++
          return true
        })

        try {
          await handleEvent(instance, connection, event)
          const pending = await ClarusAssignmentStore.findByIdentity({
            accountId: AGENT_ID,
            projectID: event.projectID,
            taskID: event.taskID,
          })
          expect(pending?.assignment).toMatchObject({
            acceptState: "pending",
            acceptRequestID: event.requestID,
          })
          const firstInbox = await SessionInbox.list(pending!.assignment.sessionID)

          await handleEvent(instance, connection, event)

          expect(dispatchCalls).toBe(1)
          expect(wakeCalls).toBe(1)
          expect(acceptRequestIDs).toEqual([String(event.requestID)])
          expect(await SessionInbox.list(pending!.assignment.sessionID)).toEqual(firstInbox)

          resolveAccept({
            kind: "known",
            type: "runtimeTaskAccepted",
            agentID: AGENT_ID,
            requestID: String(event.requestID),
            projectID: event.projectID,
            runID: event.runID,
            taskID: event.taskID,
            subtaskID: event.subtaskID,
            attempt: event.attempt,
            acceptedAt: new Date().toISOString(),
            epoch: 1,
            generation: 1,
          })
          await waitFor(
            () =>
              ClarusAssignmentStore.findByIdentity({
                accountId: AGENT_ID,
                projectID: event.projectID,
                taskID: event.taskID,
              }),
            (located) => located?.assignment.acceptState === "acknowledged",
          )
        } finally {
          host.tasks.dispatch = originalDispatch
          ;(SessionDrive.request as typeof SessionDrive.request) = originalRequest
        }
      },
    })
  })

  test("dispatches accept after binding and before wake without waiting for its ACK", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({ externalProjectId: "project-order", name: "Order project", isActive: true })
        const order: string[] = []
        let resolveAccept!: (value: unknown) => void
        const acceptResponse = new Promise((resolve) => {
          resolveAccept = resolve
        })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-order",
          taskID: "task-order",
          runID: "run-order",
          subtaskID: "subtask-order",
          attempt: 3,
          requestID: "assignment-order",
        })
        const tunnel = testTunnel({
          acceptTask: (input: Record<string, unknown>) => {
            order.push("accept")
            expect(input).toMatchObject({
              runID: event.runID,
              projectID: event.projectID,
              taskID: event.taskID,
              subtaskID: event.subtaskID,
              attempt: event.attempt,
            })
            return { requestID: input.requestID, response: acceptResponse }
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel,
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Order project"]]),
          outboundRequests: new Set(),
        }
        const originalRequest = SessionDrive.request
        ;(SessionDrive.request as unknown as (...args: unknown[]) => Promise<boolean>) = mock(async () => {
          const located = await ClarusAssignmentStore.findByIdentity({
            accountId: AGENT_ID,
            projectID: event.projectID,
            taskID: event.taskID,
          })
          expect(located?.assignment.status).toBe("running")
          order.push("wake")
          return true
        })

        try {
          const dispatch = handleEvent(instance, connection, event)
          const completedBeforeAck = await Promise.race([dispatch.then(() => true), Bun.sleep(100).then(() => false)])
          expect(completedBeforeAck).toBe(true)
          expect(order).toEqual(["accept", "wake"])
          resolveAccept({ ...acceptedTaskPayload(event), type: "runtimeTaskAccepted" })
          await dispatch
        } finally {
          ;(SessionDrive.request as typeof SessionDrive.request) = originalRequest
        }
      },
    })
  })

  test("runtime accepted beats a concurrent transport failure and never regresses", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({ externalProjectId: "project-accept-race", name: "Accept race", isActive: true })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-accept-race",
          taskID: "task-accept-race",
          runID: "run-accept-race",
          subtaskID: "subtask-accept-race",
          requestID: "assignment-accept-race",
        })
        let rejectAccept!: (error: unknown) => void
        const response = new Promise<never>((_, reject) => {
          rejectAccept = reject
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel: testTunnel({
            acceptTask: (input: Parameters<ClarusAgentTunnelPort["acceptTask"]>[0]) => ({
              requestID: input.requestID,
              response,
            }),
          }),
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Accept race"]]),
          outboundRequests: new Set(),
        }

        await handleEvent(instance, connection, event)
        const acceptedAt = new Date().toISOString()
        await handleEvent(instance, connection, {
          kind: "known",
          type: "runtimeTaskAccepted",
          agentID: AGENT_ID,
          requestID: String(event.requestID),
          projectID: event.projectID,
          runID: event.runID,
          taskID: event.taskID,
          subtaskID: event.subtaskID,
          attempt: event.attempt,
          acceptedAt,
          epoch: 1,
          generation: 1,
        })
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            })
          )?.assignment,
        ).toMatchObject({ acceptState: "acknowledged", acceptRequestID: event.requestID, acceptedAt })
        await handleEvent(instance, connection, {
          kind: "known",
          type: "runtimeTaskAccepted",
          agentID: AGENT_ID,
          requestID: String(event.requestID),
          projectID: event.projectID,
          runID: event.runID,
          taskID: event.taskID,
          subtaskID: event.subtaskID,
          attempt: event.attempt,
          acceptedAt: new Date(Date.parse(acceptedAt) + 1_000).toISOString(),
          epoch: 1,
          generation: 1,
        })
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            })
          )?.assignment.acceptedAt,
        ).toBe(acceptedAt)

        rejectAccept({
          disposition: "ambiguous",
          requestID: event.requestID,
          reason: "disconnected",
          message: "connection failed after accepted push",
        })
        await waitFor(
          () => connection.outboundRequests.has(String(event.requestID)),
          (inFlight) => !inFlight,
        )
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            })
          )?.assignment.acceptState,
        ).toBe("acknowledged")
      },
    })
  })

  test("unconfirmed exact replay only resends accept with the stable request ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const diagnostics: ChannelHost.DiagnosticRecordInput[] = []
        const instance = provider()
        const host = ChannelHost.create({
          channelType: "clarus",
          accountId: AGENT_ID,
          activateTasks: true,
          onDiagnostic: (record) => {
            diagnostics.push(record)
          },
        })
        await host.projects.ensure({ externalProjectId: "project-replay", name: "Replay project", isActive: true })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-replay",
          taskID: "task-replay",
          runID: "run-replay",
          subtaskID: "subtask-replay",
          requestID: "assignment-replay",
        })
        const acceptRequestIDs: string[] = []
        const tunnel = testTunnel({
          acceptTask: (input: { requestID: string }) => {
            acceptRequestIDs.push(input.requestID)
            return {
              requestID: input.requestID,
              response: Promise.reject({
                disposition: "ambiguous",
                requestID: input.requestID,
                reason: "disconnected",
                message: "connection lost after dispatch",
              }),
            }
          },
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel,
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Replay project"]]),
          outboundRequests: new Set(),
        }
        const originalRequest = SessionDrive.request
        let wakeCalls = 0
        ;(SessionDrive.request as unknown as (...args: unknown[]) => Promise<boolean>) = mock(async () => {
          wakeCalls++
          return true
        })

        let firstSessionID = ""
        let firstInbox: Awaited<ReturnType<typeof SessionInbox.list>> = []
        try {
          await handleEvent(instance, connection, event)
          await waitFor(
            () => ({ diagnostics, inFlight: connection.outboundRequests.has(String(event.requestID)) }),
            (state) => state.diagnostics.length === 1 && !state.inFlight,
          )
          const first = await ClarusAssignmentStore.findByIdentity({
            accountId: AGENT_ID,
            projectID: event.projectID,
            taskID: event.taskID,
          })
          firstSessionID = first!.assignment.sessionID
          expect(wakeCalls).toBe(1)
          expect(await countSessionsInAssignmentScope(firstSessionID)).toBe(1)
          firstInbox = await SessionInbox.list(firstSessionID)
          expect(firstInbox.length).toBeGreaterThan(0)

          await handleEvent(instance, connection, event)
          await waitFor(
            () => ({ diagnostics, inFlight: connection.outboundRequests.has(String(event.requestID)) }),
            (state) => state.diagnostics.length === 2 && !state.inFlight,
          )
        } finally {
          ;(SessionDrive.request as typeof SessionDrive.request) = originalRequest
        }

        expect(acceptRequestIDs).toEqual([String(event.requestID), String(event.requestID)])
        expect(wakeCalls).toBe(1)
        expect(await countSessionsInAssignmentScope(firstSessionID)).toBe(1)
        const located = await ClarusAssignmentStore.findByIdentity({
          accountId: AGENT_ID,
          projectID: event.projectID,
          taskID: event.taskID,
        })
        expect(located?.assignment.status).toBe("running")
        expect(located?.assignment.sessionID).toBe(firstSessionID)
        expect(await SessionInbox.list(firstSessionID)).toEqual(firstInbox)
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            level: "warn",
            message: "Clarus task accept was not acknowledged",
            data: expect.objectContaining({
              disposition: "ambiguous",
              transportDisposition: "ambiguous",
              reason: "disconnected",
              attempt: 1,
              assignmentRequestID: "assignment-replay",
              acceptRequestID: event.requestID,
            }),
          }),
        )

        await ClarusResultOutbox.submit({
          sessionID: located!.assignment.sessionID,
          payload: {
            success: true,
            output: "done despite missing accept ACK",
            artifacts: [],
            evidenceRefs: [],
            notaryRefs: [],
            error: null,
            submittedBy: "synergy",
          },
          send: async () => {},
        })
        expect((await ClarusAssignmentStore.findBySessionID(located!.assignment.sessionID))?.assignment).toMatchObject({
          status: "completed",
          resultState: "acknowledged",
        })
      },
    })
  })
  test("late correlated acknowledgement upgrades ambiguous accept state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({ externalProjectId: "project-late-ack", name: "Late ACK", isActive: true })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-late-ack",
          taskID: "task-late-ack",
          runID: "run-late-ack",
          subtaskID: "subtask-late-ack",
          requestID: "assignment-late-ack",
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel: testTunnel({
            acceptTask: (input: Parameters<ClarusAgentTunnelPort["acceptTask"]>[0]) => ({
              requestID: input.requestID,
              response: Promise.reject({
                disposition: "ambiguous",
                requestID: input.requestID,
                reason: "timeout",
                message: "accept timed out after dispatch",
              }),
            }),
          }),
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Late ACK"]]),
          outboundRequests: new Set(),
        }

        await handleEvent(instance, connection, event)
        await waitFor(
          () =>
            ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            }),
          (located) => located?.assignment.acceptState === "ambiguous",
        )
        await handleEvent(instance, connection, {
          kind: "known",
          type: "runtimeTaskAccepted",
          agentID: AGENT_ID,
          requestID: String(event.requestID),
          projectID: event.projectID,
          runID: event.runID,
          taskID: event.taskID,
          subtaskID: event.subtaskID,
          attempt: event.attempt + 1,
          acceptedAt: new Date().toISOString(),
          epoch: 1,
          generation: 1,
        })
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            })
          )?.assignment.acceptState,
        ).toBe("ambiguous")

        const acceptedAt = new Date().toISOString()
        await handleEvent(instance, connection, {
          kind: "known",
          type: "runtimeTaskAccepted",
          agentID: AGENT_ID,
          requestID: String(event.requestID),
          projectID: event.projectID,
          runID: event.runID,
          taskID: event.taskID,
          subtaskID: event.subtaskID,
          attempt: event.attempt,
          acceptedAt,
          epoch: 1,
          generation: 1,
        })
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: AGENT_ID,
              projectID: event.projectID,
              taskID: event.taskID,
            })
          )?.assignment,
        ).toMatchObject({ acceptState: "acknowledged", acceptRequestID: event.requestID, acceptedAt })
      },
    })
  })

  test("reads legacy assignment records with default accept state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({
          externalProjectId: "project-legacy-accept",
          name: "Legacy accept",
          isActive: true,
        })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-legacy-accept",
          taskID: "task-legacy-accept",
          requestID: "assignment-legacy-accept",
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel: testTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Legacy accept"]]),
          outboundRequests: new Set(),
        }

        await handleEvent(instance, connection, event)
        const located = await ClarusAssignmentStore.findByIdentity({
          accountId: AGENT_ID,
          projectID: event.projectID,
          taskID: event.taskID,
        })
        const legacy = { ...(located!.assignment as unknown as Record<string, unknown>) }
        delete legacy.acceptState
        delete legacy.acceptRequestID
        delete legacy.acceptedAt
        await Storage.write(StoragePath.clarusProviderAssignment(located!.accountHash, located!.assignmentHash), legacy)

        const reloaded = await ClarusAssignmentStore.find(located!.accountHash, located!.assignmentHash)
        expect(reloaded?.assignment).toMatchObject({ acceptState: "none" })
        expect((reloaded?.assignment as unknown as Record<string, unknown>).acceptRequestID).toBeUndefined()
        expect((reloaded?.assignment as unknown as Record<string, unknown>).acceptedAt).toBeUndefined()
      },
    })
  })

  test("exact replay restores a lost deadline agenda", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const instance = provider()
        const host = ChannelHost.create({ channelType: "clarus", accountId: AGENT_ID, activateTasks: true })
        await host.projects.ensure({
          externalProjectId: "project-replay-agenda",
          name: "Replay agenda",
          isActive: true,
        })
        const event = taskAssignedEvent({
          agentID: AGENT_ID,
          projectID: "project-replay-agenda",
          taskID: "task-replay-agenda",
          runID: "run-replay-agenda",
          subtaskID: "subtask-replay-agenda",
          requestID: "assignment-replay-agenda",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        const connection: TestConnection = {
          accountId: AGENT_ID,
          config: accountConfig(),
          tunnel: testTunnel(),
          signal: new AbortController().signal,
          host,
          projects: new Map([[event.projectID, "Replay agenda"]]),
          outboundRequests: new Set(),
        }
        const identity = { accountId: AGENT_ID, projectID: event.projectID, taskID: event.taskID }

        await handleEvent(instance, connection, event)
        await waitFor(
          () => AgendaStore.find(ClarusDeadlineAgenda.itemID(identity)),
          (found) => found?.item.status === "active",
        )
        await ClarusDeadlineAgenda.cancel(identity)

        await handleEvent(instance, connection, event)
        await waitFor(
          () => AgendaStore.find(ClarusDeadlineAgenda.itemID(identity)),
          (found) => found?.item.status === "active",
        )
      },
    })
  })
})
