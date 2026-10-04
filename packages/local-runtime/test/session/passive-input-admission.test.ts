import { afterAll, expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { submitInput } from "../../src/session-api"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

for (const paused of [false, true])
  test(`overlapping passive inputs preserve ${paused ? "paused" : "idle"} state without scheduling a model reply`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "passive/test",
          provider: {
            passive: {
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
              models: { test: { name: "Test", limit: { context: 128000, output: 4096 } } },
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          if (paused) await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          const pause = await SessionLifecycle.snapshot(session.id)
          const firstID = Identifier.ascending("message"),
            secondID = Identifier.ascending("message")
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>()
          const materialize = SessionInbox.materializeItem
          using barrier = spyOn(SessionInbox, "materializeItem").mockImplementation(async (...args) => {
            if (args[0].messageID === firstID) {
              entered.resolve()
              await release.promise
            }
            return materialize(...args)
          })
          using loop = spyOn(SessionInvoke, "loop")
          let secondSubmission: ReturnType<typeof submitInput> | undefined
          try {
            await submitInput({
              sessionID: session.id,
              messageID: firstID,
              noReply: true,
              parts: [{ type: "text", text: "first" }],
            })
            await Promise.race([
              entered.promise,
              Bun.sleep(2000).then(() => {
                throw Error("Passive input did not start")
              }),
            ])
            expect(SessionManager.isRunning(session.id)).toBe(true)
            secondSubmission = submitInput({
              sessionID: session.id,
              messageID: secondID,
              noReply: true,
              parts: [{ type: "text", text: "second" }],
            })
            await Promise.race([
              secondSubmission,
              Bun.sleep(1000).then(() => {
                throw Error("Passive admission waited on its own materialization")
              }),
            ])
            expect((await SessionInputStatus.get({ sessionID: session.id, messageID: secondID })).durable).toBe(true)
            release.resolve()
            const deadline = Date.now() + 2000
            while (
              Date.now() < deadline &&
              !(await SessionInputStatus.get({ sessionID: session.id, messageID: secondID })).canonical &&
              !loop.mock.calls.length
            )
              await Bun.sleep(5)
            expect(loop).not.toHaveBeenCalled()
            expect(await SessionInputStatus.get({ sessionID: session.id, messageID: firstID })).toMatchObject({
              state: "completed",
              canonical: true,
            })
            expect(await SessionInputStatus.get({ sessionID: session.id, messageID: secondID })).toMatchObject({
              state: "completed",
              canonical: true,
            })
            expect(await SessionLifecycle.snapshot(session.id)).toEqual(pause)
          } finally {
            release.resolve()
            await secondSubmission?.catch(() => {})
            await SessionManager.drain()
          }
        },
      })
    }))
