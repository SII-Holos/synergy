import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("HTTP remove/list/restore preserves the input without exposing private configuration or duplicating work", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "Keep this direction" }],
        })
        const before = await SessionInbox.getStored(session.id, item.id)
        const lease = SessionManager.acquire(session.id)
        if (!lease) throw new Error("Expected owned loop lease")
        const request = (suffix: string, method = "GET") =>
          Server.App().request(`/session/${session.id}/inbox${suffix}?scopeID=${encodeURIComponent(scope.id)}`, {
            method,
          })
        try {
          expect((await request(`/${item.id}`, "DELETE")).status).toBe(204)
          const removed = await request("/removed")
          expect(removed.status).toBe(200)
          const data = (await removed.json()) as Array<{ id: string; input?: unknown }>
          expect(data.map((entry) => entry.id)).toEqual([item.id])
          expect(data[0]?.input).toBeUndefined()
          expect((await request(`/${item.id}/restore`, "POST")).status).toBe(204)
          expect((await request(`/${item.id}/restore`, "POST")).status).toBe(204)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)
          expect((await SessionInbox.getStored(session.id, item.id)).input).toEqual(before.input)
          expect(await (await request("/removed")).json()).toEqual([])
          expect((await request("/inb_missing/restore", "POST")).status).toBe(404)
        } finally {
          await SessionInbox.remove({ sessionID: session.id, itemID: item.id })
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  }))
