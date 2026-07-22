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

  test("project REST wire fields are converted at the provider boundary", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [{ project_id: "project-wire", title: "Wire Project", status: "active" }],
              next_cursor: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      { preconnect: originalFetch.preconnect },
    )
    try {
      const client = new ClarusProjectClient(
        "https://api.holosai.io",
        async () => ({ agentID: "account-a", agentSecret: "secret" }),
        new AbortController().signal,
      )
      const page = await client.listProjects()
      expect(page.projects).toEqual([{ projectID: "project-wire", projectName: "Wire Project", status: "active" }])
      expect(page.nextCursor).toBeUndefined()
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
