import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusOutbox } from "../../src/channel/provider/clarus/outbox"
import { ClarusProjectClient } from "../../src/channel/provider/clarus/project-client"
import { ClarusProjectSync } from "../../src/channel/provider/clarus/project-sync"
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

describe("Clarus Channel provider", () => {
  test("assignment state points to one ordinary Session in the project Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId: "account-a",
          projectID: "project-a",
          projectName: "Project A",
        })
        const event = assignment("project-a")

        const first = await ClarusAssignmentStore.ensure({ accountId: "account-a", scope, event })
        const second = await ClarusAssignmentStore.ensure({ accountId: "account-a", scope, event })
        const session = await Session.get(first.assignment.sessionID)

        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(second.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(session.scope.id).toBe(scope.id)
        expect(session.endpoint).toBeUndefined()
        expect(session.interaction).toEqual({ mode: "unattended", source: "channel:clarus" })
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
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

  test("project discovery snapshot remains provider-private and reloadable", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountHash = new Bun.CryptoHasher("sha256").update("sync-account").digest("hex")
        await ClarusProjectSync.save(
          accountHash,
          new Map([
            ["project-a", "Project A"],
            ["project-b", undefined],
          ]),
        )

        expect(await ClarusProjectSync.load(accountHash)).toEqual(
          new Map([
            ["project-a", "Project A"],
            ["project-b", undefined],
          ]),
        )
      },
    })
  })

  test("outbox persists before dispatch and only retries definite non-dispatch", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountHash = new Bun.CryptoHasher("sha256").update("outbox-account").digest("hex")
        let persistedBeforeSend = false
        const acknowledged = await ClarusOutbox.enqueue({
          accountHash,
          projectID: "project-a",
          content: "hello",
          send: async () => {
            const hashes = await Storage.scan(StoragePath.clarusProviderMessageOutboxRoot(accountHash))
            const record = await Storage.read<{ state: string }>(
              StoragePath.clarusProviderMessageOutbox(accountHash, hashes[0]!),
            )
            persistedBeforeSend = record.state === "pending"
            return { messageID: "message-a" }
          },
        })
        expect(acknowledged).toEqual({ messageID: "message-a" })
        expect(persistedBeforeSend).toBe(true)

        const failure = {
          disposition: "not_dispatched" as const,
          requestID: "request-a",
          code: "NOT_CONNECTED",
          message: "not connected",
        }
        await expect(
          ClarusOutbox.enqueue({
            accountHash,
            projectID: "project-a",
            content: "retry me",
            send: async () => {
              throw failure
            },
          }),
        ).rejects.toEqual(failure)

        const rejected = {
          disposition: "rejected" as const,
          requestID: "request-rejected",
          code: "FORBIDDEN",
          message: "forbidden",
        }
        await expect(
          ClarusOutbox.enqueue({
            accountHash,
            projectID: "project-a",
            content: "reject me",
            send: async () => {
              throw rejected
            },
          }),
        ).rejects.toEqual(rejected)
        await expect(
          ClarusOutbox.enqueue({
            accountHash,
            projectID: "project-a",
            content: "ambiguous send",
            send: async () => {
              throw new Error("connection ended after dispatch")
            },
          }),
        ).rejects.toThrow("connection ended after dispatch")

        const beforeRecovery = await Storage.scan(StoragePath.clarusProviderMessageOutboxRoot(accountHash))
        const records = await Promise.all(
          beforeRecovery.map((recordHash) =>
            Storage.read<{ state: string; requestID: string; content: string }>(
              StoragePath.clarusProviderMessageOutbox(accountHash, recordHash),
            ),
          ),
        )
        const retry = records.find((record) => record.content === "retry me")!
        expect(retry.state).toBe("not_dispatched")
        expect(records.find((record) => record.content === "reject me")?.state).toBe("rejected")
        expect(records.find((record) => record.content === "ambiguous send")?.state).toBe("ambiguous")

        let retriedRequestID: string | undefined
        await ClarusOutbox.recover({
          accountHash,
          send: async (input) => {
            retriedRequestID = input.requestID
            return { messageID: "message-retried" }
          },
        })
        expect(retriedRequestID).toBeString()
        expect(retriedRequestID).not.toBe(retry.requestID)

        await Storage.write(StoragePath.clarusProviderMessageOutbox(accountHash, "crash-pending"), {
          requestID: "request-pending",
          projectID: "project-a",
          content: "possibly sent",
          state: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        let unsafeRetries = 0
        await ClarusOutbox.recover({
          accountHash,
          send: async () => {
            unsafeRetries++
            return { messageID: "unexpected" }
          },
        })
        expect(unsafeRetries).toBe(0)
        expect(
          await Storage.read<{ state: string }>(StoragePath.clarusProviderMessageOutbox(accountHash, "crash-pending")),
        ).toMatchObject({ state: "ambiguous" })
      },
    })
  })

  test("assignment result outbox settles durable states without unsafe retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await Channel.ensureProjectScope({
          channelType: "clarus",
          accountId: "result-account",
          projectID: "result-project",
        })
        const event = { ...assignment("result-project"), agentID: "result-account" }
        const created = await ClarusAssignmentStore.ensure({ accountId: "result-account", scope, event })
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
        const second = await ClarusAssignmentStore.ensure({ accountId: "result-account", scope, event: secondEvent })
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
        const rejectedAssignment = await ClarusAssignmentStore.ensure({
          accountId: "result-account",
          scope,
          event: rejectedEvent,
        })
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
        const pendingAssignment = await ClarusAssignmentStore.ensure({
          accountId: "result-account",
          scope,
          event: pendingEvent,
        })
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
