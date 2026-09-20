import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function createIncompleteAssistant(sessionID: string) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function createRecoverableSession(title: string) {
  const session = await Session.create({ title })
  await createIncompleteAssistant(session.id)
  await Session.update(session.id, (draft) => {
    draft.pendingReply = true
  })
  return session
}

describe("SessionManager.activeRuntimeCount", () => {
  test("counts every non-idle runtime status and drops idle or unregistered runtimes", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const baseline = SessionManager.activeRuntimeCount()
          const sessions = await Promise.all(
            ["Idle", "Busy", "Retry", "Recovering"].map((title) => Session.create({ title })),
          )
          const [idle, busy, retry, recovering] = sessions

          // create() registers an idle runtime per session, which is not activity.
          expect(SessionManager.activeRuntimeCount()).toBe(baseline)

          SessionManager.setStatus(busy.id, { type: "busy", description: "working" })
          SessionManager.setStatus(retry.id, {
            type: "retry",
            attempt: 1,
            message: "retrying",
            next: Date.now() + 1000,
          })
          SessionManager.setStatus(recovering.id, { type: "recovering", reason: "incomplete-turn" })

          try {
            expect(SessionManager.getRuntime(idle.id)?.status).toEqual({ type: "idle" })
            expect(SessionManager.activeRuntimeCount()).toBe(baseline + 3)

            SessionManager.setStatus(busy.id, { type: "idle" })
            expect(SessionManager.activeRuntimeCount()).toBe(baseline + 2)

            SessionManager.unregisterRuntime(retry.id)
            expect(SessionManager.activeRuntimeCount()).toBe(baseline + 1)
          } finally {
            for (const session of sessions) {
              SessionManager.unregisterRuntime(session.id)
              await Session.remove(session.id)
            }
          }
        },
      })
    }))

  test("reads no storage and excludes sessions only the cross-scope recovery scan can find", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const project = await tmp.scope()
      await ScopeContext.provide({
        scope: project,
        fn: async () => {
          // create() registers an idle runtime, so drop it to model a session still
          // queued for recovery after a restart. Only a disk scan can see it.
          const queued = await createRecoverableSession("Queued for recovery")
          SessionManager.unregisterRuntime(queued.id)

          try {
            const baseline = SessionManager.activeRuntimeCount()
            const read = spyOn(Storage, "read")
            const scan = spyOn(Storage, "scan")
            const query = spyOn(Storage, "query")
            const records = spyOn(Storage, "records")
            try {
              expect(SessionManager.activeRuntimeCount()).toBe(baseline)
              expect(read).not.toHaveBeenCalled()
              expect(scan).not.toHaveBeenCalled()
              expect(query).not.toHaveBeenCalled()
              expect(records).not.toHaveBeenCalled()

              // Positive control: the same spies must observe the cross-scope scan
              // the poll is replacing, which is what proves they can detect IO.
              expect((await SessionManager.listStatuses())[queued.id]).toEqual({
                type: "recovering",
                reason: "incomplete-turn",
              })
              const scopedIO = read.mock.calls.length + scan.mock.calls.length + query.mock.calls.length
              expect(scopedIO + records.mock.calls.length).toBeGreaterThan(0)
            } finally {
              read.mockRestore()
              scan.mockRestore()
              query.mockRestore()
              records.mockRestore()
            }
          } finally {
            await Session.remove(queued.id)
          }
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
