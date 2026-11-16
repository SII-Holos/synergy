import { expect, test } from "bun:test"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { PausedTurnAbort } from "../../src/session/error"
import { SessionInteraction } from "../../src/session/interaction"
import { MessageV2 } from "../../src/session/message-v2"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("the native Session maintenance owner drains a paused turn and its real tail without cancelling or replaying its root", async () => {
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create({ interaction: SessionInteraction.unattended("maintenance-fixture") })
        const input = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "Keep this exact task" }],
        })
        await SessionInbox.materializeNextTask(session.id)
        const entered = Promise.withResolvers<void>()
        const tail = Promise.withResolvers<void>()
        const saved = Promise.withResolvers<void>()
        let executions = 0
        const running = SessionManager.run(session.id, async (lease) => {
          executions++
          SessionManager.bindRootTask(lease, input.messageID)
          entered.resolve()
          await new Promise<void>((resolve) => {
            if (lease.signal.aborted) resolve()
            else lease.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          expect(PausedTurnAbort.is(lease.signal.reason)).toBe(true)
          tail.resolve()
          await saved.promise
          await Storage.write(["native-tail", "checkpoint"], { rootID: input.messageID })
        })
        await entered.promise
        let lease: RuntimeMaintenance.Lease | undefined
        try {
          lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: "session-owner",
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Host operator",
              clientKind: "system",
              requestID: "session-owner",
            },
          })
          const draining = RuntimeMaintenance.drain(lease)
          await tail.promise
          expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
          expect(SessionManager.isRunning(session.id)).toBe(true)
          saved.resolve()
          const receipt = await draining
          await running
          await RuntimeMaintenance.freeze(lease, receipt)
          expect(await Storage.read(["native-tail", "checkpoint"])).toEqual({ rootID: input.messageID })
          const root = await MessageV2.readInfo({
            scopeID: session.scope.id,
            sessionID: session.id,
            messageID: input.messageID,
          })
          expect(root.role).toBe("user")
          if (root.role !== "user") throw new Error("The native root was replaced")
          expect(root.isRoot).toBe(true)
          expect((await Session.get(session.id)).paused).toBeUndefined()
          expect(SessionManager.isRunning(session.id)).toBe(false)
          await RuntimeMaintenance.release(lease)
          expect(executions).toBe(1)
          expect(SessionManager.hasPendingWake(session.id)).toBe(false)
        } finally {
          saved.resolve()
          SessionManager.signalAbort(session.id, { pauseTurn: true })
          await running
          if (lease && (await RuntimeMaintenance.status())?.phase !== "released")
            await RuntimeMaintenance.release(lease)
        }
      },
    })
  })
}, 15_000)
