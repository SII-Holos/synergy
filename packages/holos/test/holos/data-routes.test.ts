import { expect, test } from "bun:test"
import { Hono } from "hono"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Mailbox } from "../../src/holos/mailbox"
import { HolosDataRoute } from "../../src/holos/routes/holos"
import { testRuntime } from "../support/runtime"

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

test("Holos-only contact routes remain isolated across interleaved Runtimes", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  await using tmp = await tmpdir({})
  const firstApp = first.run(() => new Hono().route("/holos", HolosDataRoute()))
  const secondApp = second.run(() => new Hono().route("/holos", HolosDataRoute()))
  const scope = await first.run(() => tmp.scope())
  await first.run(() =>
    ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await firstApp.request(
          "/holos/contact",
          json("POST", { id: "contact-one", name: "First contact" }),
        )
        expect(created.status).toBe(200)
        expect(await created.json()).toMatchObject({ id: "contact-one", name: "First contact", blocked: false })
        const blocked = await firstApp.request("/holos/contact/contact-one/block", json("PUT", { blocked: true }))
        expect(blocked.status).toBe(200)
        expect(await blocked.json()).toMatchObject({ id: "contact-one", blocked: true })
      },
    }),
  )
  await second.run(async () => {
    expect(await (await secondApp.request("/holos/contact")).json()).toEqual([])
    expect((await secondApp.request("/holos/contact/contact-one")).status).toBe(404)
    expect((await secondApp.request("/holos/contact/contact-one/block", json("PUT", { blocked: true }))).status).toBe(
      404,
    )
  })
  await second.close()
  await first.run(() =>
    ScopeContext.provide({
      scope,
      fn: async () => {
        expect(await (await firstApp.request("/holos/contact/contact-one")).json()).toMatchObject({
          id: "contact-one",
          blocked: true,
        })
        expect(await (await firstApp.request("/holos/contact/contact-one", { method: "DELETE" })).json()).toBe(true)
        expect(await (await firstApp.request("/holos/contact")).json()).toEqual([])
        expect((await firstApp.request("/holos/contact/contact-one")).status).toBe(404)
      },
    }),
  )
})

test("Holos-only mailbox keeps failed delivery and received history without Channels", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const app = new Hono().route("/holos", HolosDataRoute())
    expect(await (await app.request("/holos/credentials/status")).json()).toEqual({ exists: false })
    expect(await (await app.request("/holos/status")).json()).toMatchObject({ agentId: null, peerId: null })
    expect((await app.request("/holos/profile")).status).toBe(400)
    const received = await Mailbox.receive({ fromId: "contact-one", text: "Incoming", messageId: "incoming-one" })
    const send = await app.request(
      "/holos/send",
      json("POST", { toId: "contact-one", text: "Outgoing", replyToMessageId: received.id }),
    )
    expect(send.status).toBe(200)
    const sent = (await send.json()) as { messageId: string; sent: boolean; reason: string }
    expect(sent).toMatchObject({ sent: false, reason: "no_provider" })
    expect(await (await app.request(`/holos/send/${sent.messageId}/retry`, { method: "POST" })).json()).toEqual(sent)
    expect((await app.request("/holos/send/missing/retry", { method: "POST" })).status).toBe(404)
    expect(await (await app.request("/holos/inbox")).json()).toEqual([received])
    expect(await (await app.request("/holos/outbox")).json()).toMatchObject([
      { id: sent.messageId, status: "failed", replyToMessageId: received.id },
    ])
    expect(
      ((await (await app.request("/holos/thread/contact-one")).json()) as Mailbox.Message[])
        .map((message) => message.id)
        .sort(),
    ).toEqual([received.id, sent.messageId].sort())
    expect(await (await app.request("/holos/thread/absent")).json()).toEqual([])
  })
})
