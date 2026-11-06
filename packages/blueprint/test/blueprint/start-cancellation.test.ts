import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { BlueprintLoopService } from "../../src/blueprint/service"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { LoopEvent } from "../../src/blueprint/event"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

for (const wrapped of [false, true])
  for (const pause of [false, true])
    test(`first-prompt interruption preserves ${pause ? "pause then cancel" : "explicit cancellation"} (${wrapped ? "terminal" : "raw"} error)`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create(),
              note = await NoteStore.create({ title: "Cancellation", kind: "blueprint", blueprint: {} }),
              loop = await BlueprintLoopStore.create({ noteID: note.id, title: note.title, sessionID: session.id })
            const entered = Promise.withResolvers<void>()
            const delivery = spyOn(SessionManager, "deliver").mockImplementation(async () => {
              const lease = SessionManager.acquire(session.id)!
              try {
                entered.resolve()
                await new Promise<void>((_, reject) =>
                  lease.signal.addEventListener(
                    "abort",
                    () =>
                      reject(
                        wrapped
                          ? new MessageV2.SessionTerminalError({
                              errorName: MessageV2.AbortedError.name,
                              message: "The operation was aborted.",
                            })
                          : lease.signal.reason,
                      ),
                    { once: true },
                  ),
                )
              } finally {
                await SessionManager.release(lease)
              }
            })
            try {
              await BlueprintLoopService.start(session.scope.id, loop.id)
              await entered.promise
              expect(SessionManager.isRunning(session.id)).toBe(true)
              if (pause) {
                await SessionAbort.abort(session.id)
                expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).status).toBe("running")
                expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
              }
              await SessionAbort.abort(session.id, { abandonWorkflow: true, terminalize: true })
              expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).status).toBe("cancelled")
              expect((await Session.get(session.id)).blueprint?.loopID).toBeUndefined()
              expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
              await SessionAbort.abort(session.id, { abandonWorkflow: true, terminalize: true })
              expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).status).toBe("cancelled")
            } finally {
              delivery.mockRestore()
            }
          },
        })
      }))

for (const error of [
  new Error("Delivery refused"),
  new DOMException("Transport aborted", "AbortError"),
  new MessageV2.SessionTerminalError({ errorName: MessageV2.AbortedError.name, message: "Assistant step timed out" }),
])
  test(`unrequested delivery failure remains visible: ${error.message}`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create(),
            note = await NoteStore.create({ title: "Failure", kind: "blueprint", blueprint: {} }),
            loop = await BlueprintLoopStore.create({ noteID: note.id, title: note.title, sessionID: session.id })
          const settled = Promise.withResolvers<void>()
          const unsubscribe = Bus.subscribe(LoopEvent.Updated, ({ properties }) => {
            if (properties.loop.id === loop.id && properties.loop.status === "failed") settled.resolve()
          })
          const delivery = spyOn(SessionManager, "deliver").mockImplementation(async () => {
            if (MessageV2.SessionTerminalError.isInstance(error))
              await SessionLifecycle.pause({ sessionID: session.id, reason: "failed" })
            throw error
          })
          try {
            await BlueprintLoopService.start(session.scope.id, loop.id)
            await settled.promise
            expect(await BlueprintLoopStore.get(session.scope.id, loop.id)).toMatchObject({
              status: "failed",
              error: error.message,
            })
          } finally {
            delivery.mockRestore()
            unsubscribe()
          }
        },
      })
    }))
