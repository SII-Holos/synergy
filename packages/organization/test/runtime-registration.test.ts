import { expect, test } from "bun:test"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { fixture, password } from "./support/organization"
import { keys, proof, consume, register } from "./support/runtime"

test("member Runtime tickets bind the authenticated account and machine key, and consumption has one durable result", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const [first, second] = await Promise.all([
    register(owner, "device", key.publicKey),
    register(owner, "device", key.publicKey),
  ])
  expect(first.runtime.runtimeID).toBe(second.runtime.runtimeID)
  const account = Identity.CurrentSession.parse(await (await owner.request("GET", "/auth/session")).json()).account
  expect(first.runtime.accountID).toBe(account.accountID)
  expect(first.runtime.state).toBe("pending")
  const other = await keys()
  expect(
    (await owner.request("POST", "/runtimes/member", { deviceID: "device", publicKey: other.publicKey })).status,
  ).toBe(409)
  expect(
    (
      await owner.request("POST", "/runtimes/member", {
        deviceID: "forged",
        publicKey: key.publicKey,
        accountID: "other",
      })
    ).status,
  ).toBe(400)
  expect((await consume(f, await proof(first, other.privateKey))).status).toBe(401)
  const input = await proof(first, key.privateKey)
  const responses = await Promise.all([consume(f, input), consume(f, input)])
  expect(responses.map((r) => r.status)).toEqual([200, 200])
  const accepted = await Promise.all(responses.map(async (r) => Runtime.Registration.parse(await r.json())))
  expect(accepted[0]).toEqual(accepted[1])
  expect(accepted[0]).toMatchObject({ state: "active", revision: 2, connectionEpoch: 0 })
  expect((await consume(f, { ...input, proof: { ...input.proof, orgID: "other" } })).status).toBe(401)
  await f.restart()
  const replay = await consume(f, input)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual(accepted[0])
  const list = Runtime.RegistrationPage.parse(await (await owner.request("GET", "/runtimes?limit=1")).json())
  expect(list.items).toEqual([accepted[0]])
})

test("registration visibility, revocation, pending account removal and expiry use current authority", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  const member = f.client()
  const joined = await member.request("POST", "/invites/consume", {
    token: invitation.token,
    requestID: crypto.randomUUID(),
    loginName: "member",
    displayName: "Member",
    password,
  })
  const account = Identity.Account.parse(await joined.json())
  await member.login("member")
  const key = await keys()
  const own = await register(owner, "same-device", key.publicKey)
  const other = await register(member, "same-device", key.publicKey)
  expect(own.runtime.runtimeID).not.toBe(other.runtime.runtimeID)
  expect((await member.request("GET", `/runtimes/${own.runtime.runtimeID}`)).status).toBe(404)
  expect(
    (await member.request("POST", `/runtimes/${own.runtime.runtimeID}/revoke`, { expectedRevision: 1 })).status,
  ).toBe(404)
  const memberList = Runtime.RegistrationPage.parse(await (await member.request("GET", "/runtimes")).json())
  expect(memberList.items.map((r) => r.runtimeID)).toEqual([other.runtime.runtimeID])
  const input = await proof(own, key.privateKey)
  const active = Runtime.Registration.parse(await (await consume(f, input)).json())
  expect((await owner.request("POST", `/runtimes/${active.runtimeID}/revoke`, { expectedRevision: 1 })).status).toBe(
    409,
  )
  const revoked = await owner.request("POST", `/runtimes/${active.runtimeID}/revoke`, {
    expectedRevision: active.revision,
  })
  expect(revoked.status).toBe(200)
  expect(Runtime.Registration.parse(await revoked.json()).state).toBe("revoked")
  expect((await consume(f, input)).status).toBe(200)
  expect(
    Runtime.Registration.parse(await (await owner.request("GET", `/runtimes/${active.runtimeID}`)).json()).state,
  ).toBe("revoked")
  expect(
    (
      await owner.request("PATCH", `/accounts/${account.accountID}`, {
        expectedRevision: account.revision,
        state: "removed",
      })
    ).status,
  ).toBe(200)
  expect((await consume(f, await proof(other, key.privateKey))).status).toBe(401)
  await using expired = await fixture(undefined, { registration: { ticketMs: 1 } })
  const expiring = await register(await expired.initialize(), "device", key.publicKey)
  await Bun.sleep(5)
  expect((await consume(expired, await proof(expiring, key.privateKey))).status).toBe(401)
})
