import { afterAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionRoute } from "../../src/server/session"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/session", SessionRoute())

for (const endpoint of ["input", "prompt_async"]) {
  test(`${endpoint} waits for durable noReply admission before acknowledging`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const blocked = Storage.transaction(async () => {
            entered.resolve()
            await release.promise
          })
          await entered.promise
          let accepted = false
          const request = Promise.resolve(
            app.request(`/session/${session.id}/${endpoint}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messageID: "msg_durable_admission",
                noReply: true,
                parts: [{ type: "text", text: "Persist this input" }],
              }),
            }),
          ).then((response) => {
            accepted = true
            return response
          })
          try {
            await Bun.sleep(50)
            expect(accepted).toBe(false)
          } finally {
            release.resolve()
            await blocked
          }
          const response = await request
          expect(response.status).toBe(endpoint === "input" ? 200 : 204)
          const inbox = await SessionInbox.list(session.id)
          expect(inbox.some((item) => item.messageID === "msg_durable_admission")).toBe(true)
        },
      })
    }))
}
