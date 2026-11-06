import { afterAll, expect, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionSendTool } from "../../src/tools/session-send"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: `call_${sessionID}`,
    agent: "fixture",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function openRoot(sessionID: string) {
  const queued = await SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "Original task" }],
  })
  const message = await SessionInbox.materializeItem(await SessionInbox.getStored(sessionID, queued.id))
  if (!message) throw new Error("the root message did not materialize")
  const lease = SessionManager.acquire(sessionID)
  if (!lease) throw new Error("the session lease was not acquired")
  SessionManager.activate(lease)
  SessionManager.bindRootTask(lease, message.info.id)
  return lease
}

test("an unrelated session steers a peer that is running its root", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const sender = await Session.create({ workspace: null })
        const target = await Session.create({ workspace: null })
        const lease = await openRoot(target.id)
        try {
          const tool = await SessionSendTool.init()
          const result = await tool.execute(
            { target: target.id, content: "PEER-CORRECTION: keep the existing regression.", role: "user" },
            toolContext(sender.id),
          )
          expect(result.metadata.mode).toBe("steer")
          expect(result.output).toContain("next model call")
          const items = await SessionInbox.list(target.id)
          expect(items).toHaveLength(1)
          expect(items[0]?.mode).toBe("steer")
          expect(await SessionInbox.hasRunnableItem(target.id)).toBe(true)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          await Session.remove(target.id)
          await Session.remove(sender.id)
        }
      },
    }),
  ))

test("an unrelated session queues a new task when the target has no live root", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const sender = await Session.create({ workspace: null })
        const target = await Session.create({ workspace: null })
        SessionManager.closeAdmission()
        try {
          const tool = await SessionSendTool.init()
          const result = await tool.execute(
            { target: target.id, content: "Start a new task.", role: "user" },
            toolContext(sender.id),
          )
          expect(result.metadata.mode).toBe("task")
          expect(result.output).toContain("queued as a new task")
          expect((await SessionInbox.list(target.id))[0]?.mode).toBe("task")
          expect(await SessionInbox.latestRootID(target.id)).toBeUndefined()
        } finally {
          SessionManager.openAdmission()
          await Session.remove(target.id)
          await Session.remove(sender.id)
        }
      },
    }),
  ))

test("a peer steer is parked when its root closes before consumption", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const sender = await Session.create({ workspace: null })
        const target = await Session.create({ workspace: null })
        const lease = await openRoot(target.id)
        try {
          const tool = await SessionSendTool.init()
          const result = await tool.execute(
            { target: target.id, content: "PEER-CORRECTION: arrive before the root closes.", role: "user" },
            toolContext(sender.id),
          )
          expect(result.metadata.mode).toBe("steer")
          await SessionManager.finishRootSteering(lease)
          const items = await SessionInbox.list(target.id)
          expect(items).toHaveLength(1)
          expect(items[0]).toMatchObject({ mode: "steer", status: "failed" })
          expect(await SessionInbox.hasRunnableItem(target.id)).toBe(false)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          await Session.remove(target.id)
          await Session.remove(sender.id)
        }
      },
    }),
  ))

for (const state of ["paused", "archived", "rollback", "stopping"] as const)
  test(`an unrelated session keeps task delivery when the target is ${state}`, () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const sender = await Session.create({ workspace: null })
          const target = await Session.create({ workspace: null })
          const lease = await openRoot(target.id)
          try {
            if (state === "stopping") SessionManager.signalAbort(target.id)
            else
              await Session.update(target.id, (draft) => {
                if (state === "paused") draft.paused = { reason: "aborted", since: Date.now() }
                if (state === "archived") draft.time.archived = Date.now()
                if (state === "rollback")
                  draft.history = {
                    rollback: {
                      id: Identifier.ascending("history"),
                      numTurns: 1,
                      created: Date.now(),
                      droppedMessageIDs: [],
                      droppedUserMessageIDs: [],
                      files: [],
                      patchPartIDs: [],
                      canUnrollback: true,
                    },
                  }
              })
            const tool = await SessionSendTool.init()
            const result = await tool.execute(
              { target: target.id, content: "A new follow-up", role: "user" },
              toolContext(sender.id),
            )
            expect(result.metadata.mode).toBe("task")
            expect(result.output).toContain("queued as a new task")
            expect((await SessionInbox.list(target.id))[0]?.mode).toBe("task")
          } finally {
            await SessionManager.release(lease, { requestNextWork: false })
            await Session.remove(target.id)
            await Session.remove(sender.id)
          }
        },
      }),
    ))

afterAll(() => runtime.close())
