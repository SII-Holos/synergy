import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("session completion notice route", () => {
  test("clears unread without bumping session updated time", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.completionNotice.unread = true
        })
        const before = await Session.get(session.id)

        const response = await app.request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completionNotice: { unread: false } }),
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.completionNotice).toEqual({ unread: false, silent: false })
        expect(body.time.updated).toBe(before.time.updated)

        const repeated = await app.request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completionNotice: { unread: false } }),
        })
        expect(repeated.status).toBe(200)
        expect((await repeated.json()).time.updated).toBe(before.time.updated)

        await Session.remove(session.id)
      },
    })
  })

  test("rejects client attempts to set unread true or patch silent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const unreadTrue = await app.request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completionNotice: { unread: true } }),
        })
        expect(unreadTrue.status).toBe(400)

        const silent = await app.request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completionNotice: { silent: true } }),
        })
        expect(silent.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })
})
