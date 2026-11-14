import { expect, test } from "bun:test"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { fixture, password } from "./support/organization"
import { keys, proof, consume, connection } from "./support/runtime"

test("organization administrators register hosted machines without assigning them to a member account", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const created = await owner.request("POST", "/runtimes/hosted", {
    name: "Team execution",
    publicKey: key.publicKey,
  })
  expect(created.status).toBe(200)
  const ticket = Runtime.Ticket.parse(await created.json())
  expect(ticket.runtime).toMatchObject({ runtimeKind: "hosted", name: "Team execution", state: "pending" })
  expect(ticket.runtime).not.toHaveProperty("accountID")
  expect(ticket.runtime).not.toHaveProperty("deviceID")
  const input = await proof(ticket, key.privateKey)
  const accepted = await consume(f, input)
  expect(accepted.status).toBe(200)
  const runtime = Runtime.Registration.parse(await accepted.json())
  expect(runtime).toMatchObject({ runtimeKind: "hosted", state: "active" })
  await f.restart()
  expect(await (await consume(f, input)).json()).toEqual(runtime)
  const page = Runtime.RegistrationPage.parse(await (await owner.request("GET", "/runtimes")).json())
  expect(page.items).toContainEqual(runtime)
})

test("members can discover hosted execution but cannot provision or revoke it", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const created = await owner.request("POST", "/runtimes/hosted", { name: "Team", publicKey: key.publicKey })
  expect(created.status).toBe(200)
  const ticket = Runtime.Ticket.parse(await created.json())
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  const member = f.client()
  await member.request("POST", "/invites/consume", {
    token: invitation.token,
    requestID: crypto.randomUUID(),
    loginName: "member",
    displayName: "Member",
    password,
  })
  await member.login("member")
  const account = Identity.CurrentSession.parse(await (await member.request("GET", "/auth/session")).json()).account
  expect((await member.request("POST", "/runtimes/hosted", { name: "Forged", publicKey: key.publicKey })).status).toBe(
    403,
  )
  expect((await member.request("GET", `/runtimes/${ticket.runtime.runtimeID}`)).status).toBe(200)
  const page = Runtime.RegistrationPage.parse(await (await member.request("GET", "/runtimes")).json())
  expect(page.items.some((entry) => entry.runtimeID === ticket.runtime.runtimeID)).toBe(true)
  expect(
    (await member.request("POST", `/runtimes/${ticket.runtime.runtimeID}/revoke`, { expectedRevision: 1 })).status,
  ).toBe(403)
  expect(
    (
      await owner.request("PATCH", `/accounts/${account.accountID}`, {
        expectedRevision: account.revision,
        state: "removed",
      })
    ).status,
  ).toBe(200)
  expect((await consume(f, await proof(ticket, key.privateKey))).status).toBe(200)
})

test("a hosted connection authenticates its machine identity and remains independent of member login state", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const ticket = Runtime.Ticket.parse(
    await (
      await owner.request("POST", "/runtimes/hosted", { name: "Shared execution", publicKey: key.publicKey })
    ).json(),
  )
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  const socket = new WebSocket(new URL("/runtime/v1/connect", server.url).toString().replace(/^http/, "ws"))
  const frames: unknown[] = []
  const waiting: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = []
  socket.onmessage = (event) => {
    const frame: unknown = JSON.parse(String(event.data))
    const next = waiting.shift()
    if (next) next.resolve(frame)
    else frames.push(frame)
  }
  async function next() {
    if (frames.length) return frames.shift()
    const pending = Promise.withResolvers<unknown>()
    waiting.push(pending)
    return Promise.race([
      pending.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("Hosted frame timed out")
      }),
    ])
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("Hosted socket failed"))
    })
    socket.send(JSON.stringify(await connection(runtime, key.privateKey, 1)))
    expect(await next()).toMatchObject({ type: "handshake", runtimeID: runtime.runtimeID, connectionEpoch: 1 })
    socket.send(JSON.stringify({ type: "heartbeat", connectionEpoch: 1, sequence: 1 }))
    expect(await next()).toEqual({ type: "heartbeat", connectionEpoch: 1, sequence: 1 })
    expect(await (await owner.request("GET", `/runtimes/${runtime.runtimeID}/connection`)).json()).toMatchObject({
      state: "online",
    })
    expect((await owner.request("POST", "/auth/logout", {})).status).toBe(200)
    socket.send(JSON.stringify({ type: "heartbeat", connectionEpoch: 1, sequence: 2 }))
    expect(await next()).toEqual({ type: "heartbeat", connectionEpoch: 1, sequence: 2 })
  } finally {
    socket.close()
    await server.stop(true)
  }
})
