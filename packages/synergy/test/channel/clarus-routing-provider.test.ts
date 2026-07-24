/**
 * ClarusProvider routing integration tests.
 *
 * Project discovery must remain task-only: it creates managed ownership but
 * no Project conversation Session. Only runtimeTaskAssigned creates and wakes
 * a dedicated Task Session.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { ChannelHost } from "../../src/channel/host"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

const FAKE_AGENT_ID = "test-agent"
const FAKE_AGENT_SECRET = "test-secret"

// ---------------------------------------------------------------------------
// Fake tunnel + provider setup
// ---------------------------------------------------------------------------
import { FakeNativeTunnelPort, nativeMessageTaskAssigned, taskAssignedEvent } from "./clarus-fixture"
import { ClarusProvider } from "../../src/channel/provider/clarus"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import type { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"

function accountConfig(): Config.ChannelClarusAccount {
  return {
    apiUrl: "https://clarus-api.test",
    agent: "",
    enabled: true,
  }
}

function channelConfig(): Config.ChannelClarus {
  return {
    type: "clarus",
    accounts: { "test-agent": accountConfig() },
  }
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const timeoutAt = Date.now() + 2_000
  let value = await read()
  while (!ready(value) && Date.now() < timeoutAt) {
    await Bun.sleep(5)
    value = await read()
  }
  if (!ready(value)) throw new Error("Timed out waiting for Clarus integration state")
  return value
}

describe("ClarusProvider routing integration", () => {
  let fake: FakeNativeTunnelPort
  let provider: ClarusProvider

  beforeEach(() => {
    fake = new FakeNativeTunnelPort()
    fake.setAgentID(FAKE_AGENT_ID)
    provider = new ClarusProvider({
      auth: {
        getStoredCredential: async () => ({
          agentId: FAKE_AGENT_ID,
          agentSecret: FAKE_AGENT_SECRET,
          maskedSecret: "test-••••-secret",
        }),
        getCredentialOrThrow: async () => ({
          agentId: FAKE_AGENT_ID,
          agentSecret: FAKE_AGENT_SECRET,
          maskedSecret: "test-••••-secret",
        }),
      },
      runtime: {
        status: async () => ({ status: "connected" }),
        getNativeIdentity: async () => ({
          agentID: FAKE_AGENT_ID,
          sessionID: "sess-test",
          generation: 1,
          epoch: 1,
        }),
        getNativeTunnel: async () => fake,
      },
    })
  })

  test("provider declares borrowed_transport lifecycle (no reconnect loop)", () => {
    expect(provider.lifecycle).toBe("borrowed_transport")
  })

  test("invalid assignment events record bounded structured diagnostics without raw payload", async () => {
    const diagnostics: ChannelHost.DiagnosticRecordInput[] = []
    const host = ChannelHost.create({
      channelType: "clarus",
      accountId: FAKE_AGENT_ID,
      onDiagnostic: (record) => {
        diagnostics.push(record)
      },
    })
    const handleEvent = provider as unknown as {
      handleEvent(
        connection: {
          accountId: string
          signal: AbortSignal
          host: ChannelHost.Instance
          outboundRequests: Set<string>
        },
        event: {
          kind: "invalid"
          sourceType: string
          agentID: string
          requestID: string | null
          epoch: number
          generation: number
          issues: readonly { path: PropertyKey[]; message: string }[]
        },
      ): Promise<void>
    }
    const rawSecret = "secret=assignment-payload-must-not-appear"

    await handleEvent.handleEvent(
      {
        accountId: FAKE_AGENT_ID,
        signal: new AbortController().signal,
        host,
        outboundRequests: new Set(),
      },
      {
        kind: "invalid",
        sourceType: "clarus.runtime.task.assigned",
        agentID: FAKE_AGENT_ID,
        requestID: null,
        epoch: 1,
        generation: 1,
        issues: [
          {
            path: ["retry_of_task_id"],
            message: `Invalid input: expected string, received null ${"x".repeat(1_000)}`,
          },
        ],
      },
    )

    const issueMessage = (diagnostics[0]?.data?.issues as Array<{ message: string }>)[0]!.message
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      level: "warn",
      message: "Invalid Clarus event",
      data: {
        eventType: "clarus.runtime.task.assigned",
        issues: [
          {
            path: "retry_of_task_id",
            message: expect.stringContaining("Invalid input: expected string, received null"),
          },
        ],
      },
    })
    const serialized = JSON.stringify(diagnostics[0])
    expect(serialized).not.toContain(rawSecret)
    expect(issueMessage.length).toBeLessThanOrEqual(500)
  })
  test("expired and archived assignments resolve through structured diagnostics", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const diagnostics: ChannelHost.DiagnosticRecordInput[] = []
        const host = ChannelHost.create({
          channelType: "clarus",
          accountId: FAKE_AGENT_ID,
          onDiagnostic: (record) => {
            diagnostics.push(record)
          },
        })
        const projectID = "diagnostic-project"
        await host.projects.ensure({ externalProjectId: projectID, name: "Diagnostic project", isActive: true })
        const handleEvent = provider as unknown as {
          handleEvent(
            connection: {
              accountId: string
              config: Config.ChannelClarusAccount
              signal: AbortSignal
              host: ChannelHost.Instance
              projects: Map<string, string>
              outboundRequests: Set<string>
            },
            event: ReturnType<typeof taskAssignedEvent>,
          ): Promise<void>
        }
        const connection = {
          accountId: FAKE_AGENT_ID,
          config: accountConfig(),
          signal: new AbortController().signal,
          host,
          projects: new Map([[projectID, "Diagnostic project"]]),
          outboundRequests: new Set<string>(),
        }

        await handleEvent.handleEvent(
          connection,
          taskAssignedEvent({
            agentID: FAKE_AGENT_ID,
            projectID,
            taskID: "expired-diagnostic-task",
            runID: "expired-diagnostic-run",
            deadlineAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        )
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            level: "info",
            message: "Skipped expired Clarus assignment",
            data: expect.objectContaining({ deadlineAt: expect.any(String) }),
          }),
        )
        expect((await Session.list()).total).toBe(0)

        const liveEvent = taskAssignedEvent({
          agentID: FAKE_AGENT_ID,
          projectID,
          taskID: "archived-diagnostic-task",
          runID: "archived-diagnostic-run-1",
          deadlineAt: null,
        })
        await handleEvent.handleEvent(connection, liveEvent)
        const located = await ClarusAssignmentStore.findByIdentity({
          accountId: FAKE_AGENT_ID,
          projectID,
          taskID: liveEvent.taskID,
        })
        expect(located).toBeDefined()
        const session = await Session.get(located!.assignment.sessionID)
        if (!session.endpoint) throw new Error("Expected Clarus assignment endpoint")
        const scope = await Scope.fromID(session.scope.id)
        if (!scope || scope.type !== "project") throw new Error("Expected managed Project Scope")
        await Session.archiveForEndpoint(session.endpoint, { scope })

        await handleEvent.handleEvent(connection, {
          ...liveEvent,
          requestID: crypto.randomUUID(),
          runID: "archived-diagnostic-run-2",
        })
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            level: "warn",
            message: "Clarus assignment blocked by archived Session",
            data: expect.objectContaining({ sessionID: session.id }),
          }),
        )
        expect((await Session.list()).total).toBe(0)
        expect(
          (
            await ClarusAssignmentStore.findByIdentity({
              accountId: FAKE_AGENT_ID,
              projectID,
              taskID: liveEvent.taskID,
            })
          )?.assignment.sessionID,
        ).toBe(session.id)
      },
    })
  })

  test("project discovery does not create a conversation Session at project-chat endpoint", async () => {
    const originalFetch = globalThis.fetch as unknown

    // Fake REST project list
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  project_id: "proj-discover",
                  title: "Discovered Project",
                  status: "active",
                },
              ],
              next_cursor: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as any

    const abort = new AbortController()
    const host = ChannelHost.create({ channelType: "clarus", accountId: FAKE_AGENT_ID })

    try {
      const connectPromise = provider.connect({
        accountId: FAKE_AGENT_ID,
        accountConfig: accountConfig(),
        channelConfig: channelConfig(),
        onMessage: async () => {},
        signal: abort.signal,
        onDisconnect: () => {},
        host,
      })

      const pending = await waitFor(
        async () => [...fake.pending],
        (requests) => requests.length > 0,
      )
      for (const [reqID] of pending) {
        fake.fulfill(reqID, {
          type: "clarus.project.subscribed",
          requestID: reqID,
          payload: { project_id: "proj-discover", subscribed: true },
        })
      }

      await connectPromise

      const chatEndpoint = SessionEndpoint.fromChannel({
        type: "clarus",
        accountId: FAKE_AGENT_ID,
        chatId: "proj-discover",
        chatType: "group",
      })

      const record = await ManagedProjectOwnership.find({
        channelType: "clarus",
        accountId: FAKE_AGENT_ID,
        externalProjectId: "proj-discover",
      })
      expect(record).toBeTruthy()
      expect(record?.remoteState).toBe("active")

      const scope = await Scope.fromID(record!.scopeID)
      if (!scope || scope.type !== "project") throw new Error("Scope not found")

      const session = await Session.findForEndpoint(chatEndpoint, { scope })
      expect(session).toBeUndefined()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          fake.emitEvent(
            "clarus.runtime.task.assigned",
            nativeMessageTaskAssigned(FAKE_AGENT_ID, "proj-discover", 1, 1).payload,
          )

          const taskEndpoint = SessionEndpoint.Channel.parse({
            kind: "channel",
            channel: {
              type: "clarus",
              accountId: FAKE_AGENT_ID,
              target: { kind: "task", externalProjectId: "proj-discover", externalTaskId: "task-1" },
            },
          })
          const taskSession = await waitFor(
            () => Session.findForEndpoint(taskEndpoint, { scope }),
            (value) => value !== undefined,
          )
          expect(taskSession).toBeDefined()
          const inbox = await waitFor(
            () => SessionInbox.list(taskSession!.id),
            (items) => items.length >= 2,
          )
          expect(inbox).toContainEqual(
            expect.objectContaining({
              mode: "task",
              message: expect.objectContaining({ visible: true }),
            }),
          )
          expect(inbox).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({
                visible: false,
                parts: [expect.objectContaining({ type: "text", origin: "system" })],
              }),
            }),
          )
        },
      })
    } finally {
      abort.abort()
      globalThis.fetch = originalFetch as any
    }
  })
})
