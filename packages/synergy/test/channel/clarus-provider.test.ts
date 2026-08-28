import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusProjectClient } from "../../src/channel/provider/clarus/project-client"
import { ClarusResultOutbox } from "../../src/channel/provider/clarus/result-outbox"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

function assignment(projectID: string): RuntimeTaskAssignedEvent {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "account-a",
    requestID: "assignment-message-a",
    projectID,
    runID: "run-a",
    taskID: "task-a",
    phase: "implementation",
    subtaskID: "subtask-a",
    attempt: 1,
    deadlineAt: null,
    goal: "Implement the project change",
    epoch: 1,
    generation: 1,
  }
}

async function dispatchAssignment(accountId: string, event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId })
  return ClarusAssignmentRuntime.dispatch({ host, accountId, event })
}

describe("Clarus Channel provider", () => {
  test("assignment state points to one ordinary Session in the project Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId: "account-a",
          externalProjectId: "project-a",
          projectName: "Project A",
        })
        const event = assignment("project-a")

        const first = await dispatchAssignment("account-a", event)
        const second = await dispatchAssignment("account-a", event)
        const session = await Session.get(first.assignment.sessionID)

        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(second.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(session.scope.id).toBe(scope.id)
        expect(session.endpoint).not.toBeUndefined()
        expect(session.endpoint?.channel?.target?.kind).toBe("task")
        expect(session.interaction).toEqual({ mode: "unattended", source: "channel:clarus" })
        expect(await SessionInbox.list(session.id)).toHaveLength(2)
        expect(first.assignment).not.toHaveProperty("scopeID")
        expect(first.assignment).not.toHaveProperty("workspacePath")
      },
    })
  })

  test("project discovery preserves the configured Clarus base path", async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls: URL[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)
        const status = url.searchParams.get("status")
        requestedUrls.push(url)
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [{ project_id: `project-${status}`, title: `${status} Project`, status }],
              next_cursor: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const client = new ClarusProjectClient(
        "https://api.holosai.io/environment",
        async () => ({ agentID: "account-a", agentSecret: "secret" }),
        new AbortController().signal,
      )
      const active = await client.listProjects({ status: "active" })
      const paused = await client.listProjects({ status: "paused" })
      expect(active.projects).toEqual([
        { projectID: "project-active", projectName: "active Project", status: "active" },
      ])
      expect(paused.projects).toEqual([
        { projectID: "project-paused", projectName: "paused Project", status: "paused" },
      ])
      expect(requestedUrls.map((url) => url.pathname)).toEqual([
        "/environment/api/v1/holos/clarus/projects",
        "/environment/api/v1/holos/clarus/projects",
      ])
      expect(requestedUrls.map((url) => url.searchParams.get("status"))).toEqual(["active", "paused"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("assignment result outbox settles durable states without unsafe retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId: "result-account",
          externalProjectId: "result-project",
        })
        const event = { ...assignment("result-project"), agentID: "result-account" }
        const created = await dispatchAssignment("result-account", event)
        const failure = {
          disposition: "not_dispatched" as const,
          requestID: "result-request",
          code: "NOT_CONNECTED",
          message: "not connected",
        }
        const payload = {
          success: true,
          output: "done",
          artifacts: [],
          evidenceRefs: [],
          notaryRefs: [],
          error: null,
          submittedBy: "synergy",
        }

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload,
            send: async () => {
              throw failure
            },
          }),
        ).rejects.toEqual(failure)
        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "not_dispatched",
          status: "running",
        })

        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload,
          send: async () => {},
        })
        const acknowledged = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(acknowledged?.assignment).toMatchObject({ resultState: "acknowledged", status: "completed" })

        const secondEvent = {
          ...event,
          taskID: "task-ambiguous",
          subtaskID: "subtask-ambiguous",
          runID: "run-ambiguous",
        }
        const second = await dispatchAssignment("result-account", secondEvent)
        await expect(
          ClarusResultOutbox.submit({
            sessionID: second.assignment.sessionID,
            payload,
            send: async () => {
              throw new Error("connection ended after dispatch")
            },
          }),
        ).rejects.toThrow("connection ended after dispatch")
        let unsafeRetries = 0
        await expect(
          ClarusResultOutbox.submit({
            sessionID: second.assignment.sessionID,
            payload,
            send: async () => {
              unsafeRetries++
            },
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_ASSIGNMENT_NOT_RUNNING" })
        expect(unsafeRetries).toBe(0)
        expect((await ClarusAssignmentStore.findBySessionID(second.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "ambiguous",
        })

        const rejectedEvent = {
          ...event,
          taskID: "task-rejected",
          subtaskID: "subtask-rejected",
          runID: "run-rejected",
        }
        const rejectedAssignment = await dispatchAssignment("result-account", rejectedEvent)
        const rejected = {
          disposition: "rejected" as const,
          requestID: "result-rejected",
          code: "RESULT_REJECTED",
          message: "result rejected",
        }
        await expect(
          ClarusResultOutbox.submit({
            sessionID: rejectedAssignment.assignment.sessionID,
            payload,
            send: async () => {
              throw rejected
            },
          }),
        ).rejects.toEqual(rejected)
        expect(
          (await ClarusAssignmentStore.findBySessionID(rejectedAssignment.assignment.sessionID))?.assignment,
        ).toMatchObject({ resultState: "rejected" })

        const pendingEvent = {
          ...event,
          taskID: "task-pending",
          subtaskID: "subtask-pending",
          runID: "run-pending",
        }
        const pendingAssignment = await dispatchAssignment("result-account", pendingEvent)
        const pending = await ClarusAssignmentStore.beginResult(
          pendingAssignment.assignment.sessionID,
          "request-pending",
        )
        await Storage.write(StoragePath.clarusProviderResultOutbox(pending.accountHash, "pending-result"), {
          requestID: "request-pending",
          assignmentHash: pending.assignmentHash,
          sessionID: pending.assignment.sessionID,
          payload,
          state: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await ClarusResultOutbox.recover(pending.accountHash)
        expect((await ClarusAssignmentStore.findBySessionID(pending.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "ambiguous",
        })
      },
    })
  })
})

// =============================================================================
// 5. Tunnel timeout — provider passes bounded timeoutMs
// =============================================================================

describe("Clarus provider tunnel timeout", () => {
  test("recordTaskResult receives timeoutMs: 60000", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "timeout-result-account"
        const projectID = "timeout-result-project"
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId,
          externalProjectId: projectID,
          projectName: `Project ${projectID}`,
        })
        const event = { ...assignment(projectID), agentID: accountId }
        const created = await dispatchAssignment(accountId, event)

        const { ClarusProvider } = await import("../../src/channel/provider/clarus/index")
        const provider = new ClarusProvider()

        let receivedTimeoutMs: number | undefined
        const stubConnection = {
          accountId,
          config: {} as any,
          tunnel: {
            recordTaskResult: (input: any) => {
              receivedTimeoutMs = input.timeoutMs
              return { requestID: input.requestID, response: Promise.resolve({}) }
            },
            extendTask: () => ({ requestID: "", response: Promise.resolve({} as any) }),
            subscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
            unsubscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
            registerEventHandler: () => () => {},
            registerConnectionHandler: () => () => {},
          },
          signal: new AbortController().signal,
          host: ChannelHost.create({ channelType: "clarus", accountId }),
          projects: new Map(),
          outboundRequests: new Set(),
        }

        const payload = {
          success: true,
          output: "done",
          artifacts: [],
          evidenceRefs: [],
          notaryRefs: [],
          error: null,
          submittedBy: "synergy",
        }
        const createdAssignment = created.assignment

        await (provider as any).sendTaskResult(stubConnection, {
          requestID: crypto.randomUUID(),
          assignment: createdAssignment,
          payload,
        })

        expect(receivedTimeoutMs).toBe(60_000)
      },
    })
  })

  test("extendTask receives timeoutMs: 30000", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "timeout-ext-account"
        const projectID = "timeout-ext-project"
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId,
          externalProjectId: projectID,
          projectName: `Project ${projectID}`,
        })
        const event = { ...assignment(projectID), agentID: accountId }
        const created = await dispatchAssignment(accountId, event)

        const { ClarusProvider } = await import("../../src/channel/provider/clarus/index")
        const provider = new ClarusProvider()

        let receivedTimeoutMs: number | undefined
        const stubConnection = {
          accountId,
          config: {} as any,
          tunnel: {
            extendTask: (input: any) => {
              receivedTimeoutMs = input.timeoutMs
              return {
                requestID: input.requestID,
                response: Promise.resolve({ task: { taskID: "t", deadlineAt: null, status: "running" } }),
              }
            },
            recordTaskResult: () => ({ requestID: "", response: Promise.resolve({}) }),
            subscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
            unsubscribeProject: () => ({ requestID: "", response: Promise.resolve({} as any) }),
            registerEventHandler: () => () => {},
            registerConnectionHandler: () => () => {},
          },
          signal: new AbortController().signal,
          host: ChannelHost.create({ channelType: "clarus", accountId }),
          projects: new Map(),
          outboundRequests: new Set(),
        }

        const createdAssignment = created.assignment

        await (provider as any).sendTaskExtension(stubConnection, {
          requestID: crypto.randomUUID(),
          assignment: createdAssignment,
          payload: { extend_seconds: 3600 },
        })

        expect(receivedTimeoutMs).toBe(30_000)
      },
    })
  })
})

// =============================================================================
// 6. Result payload validation before outbox/assignment mutation
// =============================================================================

describe("Clarus result outbox payload validation", () => {
  test("part content exceeding NATIVE_MAX_STRING_LENGTH is rejected before any write", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "validate-part-account"
        const projectID = "validate-part-project"
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId,
          externalProjectId: projectID,
          projectName: `Project ${projectID}`,
        })
        const event = { ...assignment(projectID), agentID: accountId }
        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const beforeHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))

        const { NATIVE_MAX_STRING_LENGTH } = await import("../../src/holos/native")
        const longContent = "x".repeat(NATIVE_MAX_STRING_LENGTH + 1)

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: {
              success: true,
              output: "done",
              artifacts: [
                {
                  artifactID: "art-1",
                  name: "oversized",
                  parts: [
                    {
                      type: "text" as const,
                      format: "markdown" as const,
                      role: "output",
                      contentKind: "text",
                      name: "part",
                      content: longContent,
                    },
                  ],
                },
              ],
              evidenceRefs: [],
              notaryRefs: [],
              error: null,
              submittedBy: "synergy",
            },
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_RESULT_PART_TOO_LARGE" })

        const afterHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))
        expect(afterHashes.length).toBe(beforeHashes.length)
      },
    })
  })

  test("parts count exceeding NATIVE_MAX_ARRAY_LENGTH is rejected before any write", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "validate-parts-account"
        const projectID = "validate-parts-project"
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId,
          externalProjectId: projectID,
          projectName: `Project ${projectID}`,
        })
        const event = { ...assignment(projectID), agentID: accountId }
        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const beforeHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))

        const { NATIVE_MAX_ARRAY_LENGTH } = await import("../../src/holos/native")
        const manyParts = Array.from({ length: NATIVE_MAX_ARRAY_LENGTH + 1 }, (_, i) => ({
          type: "text" as const,
          format: "markdown" as const,
          role: "output",
          contentKind: "text",
          name: `part-${i}`,
          content: `content-${i}`,
        }))

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: {
              success: true,
              output: "done",
              artifacts: [{ artifactID: "art-1", name: "many-parts", parts: manyParts }],
              evidenceRefs: [],
              notaryRefs: [],
              error: null,
              submittedBy: "synergy",
            },
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_RESULT_PARTS_EXCEEDED" })

        const afterHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))
        expect(afterHashes.length).toBe(beforeHashes.length)
      },
    })
  })

  test("aggregate payload exceeding NATIVE_MAX_PAYLOAD_BYTES is rejected before any write", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "validate-bytes-account"
        const projectID = "validate-bytes-project"
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId,
          externalProjectId: projectID,
          projectName: `Project ${projectID}`,
        })
        const event = { ...assignment(projectID), agentID: accountId }
        const created = await dispatchAssignment(accountId, event)
        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const beforeHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))

        const { NATIVE_MAX_STRING_LENGTH } = await import("../../src/holos/native")
        const largePart = "x".repeat(NATIVE_MAX_STRING_LENGTH)

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: {
              success: true,
              output: "done",
              artifacts: [
                {
                  artifactID: "art-1",
                  name: "aggregate",
                  parts: Array.from({ length: 5 }, (_, index) => ({
                    type: "text" as const,
                    format: "markdown" as const,
                    role: "output",
                    contentKind: "text",
                    name: `part-${index}`,
                    content: largePart,
                  })),
                },
              ],
              evidenceRefs: [],
              notaryRefs: [],
              error: null,
              submittedBy: "synergy",
            },
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_RESULT_PAYLOAD_TOO_LARGE" })

        const afterHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(located!.accountHash))
        expect(afterHashes.length).toBe(beforeHashes.length)
      },
    })
  })
})
