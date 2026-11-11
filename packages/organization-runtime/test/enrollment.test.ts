import { expect, test } from "bun:test"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import path from "node:path"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { fixture } from "./support/organization"

test("member registration uses its own machine proof over verified TLS and persists only public registration data", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  const ticket = await f.ticket(member.identity.deviceID, member.publicKey)
  const options = { home: member.home, identity: member.identity, ticket, ca: f.ca }
  const registered = await enrollMemberRuntime(options)
  expect(registered).toMatchObject({
    state: "active",
    runtimeID: ticket.runtime.runtimeID,
    publicKey: member.publicKey,
  })
  expect(await readMemberRegistration(member.home, member.identity)).toEqual(registered)
  expect(await enrollMemberRuntime(options)).toEqual(registered)
  expect(f.requests).toHaveLength(2)
  expect(f.requests.every((r) => !r.cookie && !r.authorization)).toBe(true)
  const credentials = await Bun.file(path.join(member.root, "auth", "organization-runtime.json")).json()
  expect(f.requests.map((r) => r.body).join("")).not.toContain(credentials.pkcs8)
  for await (const file of new Bun.Glob("**/*.json").scan(member.root)) {
    const text = await Bun.file(path.join(member.root, file)).text()
    expect(text).not.toContain(ticket.token)
    expect(text).not.toContain("csrfToken")
  }
})

test("a missing registration response can be reconciled with the same ticket without changing identity", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  const ticket = await f.ticket(member.identity.deviceID, member.publicKey)
  const options = { home: member.home, identity: member.identity, ticket, ca: f.ca }
  f.loseRegistrationResponse()
  await expect(enrollMemberRuntime(options)).rejects.toMatchObject({
    data: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" },
  })
  expect(await readMemberRegistration(member.home, member.identity)).toBeUndefined()
  const registered = await enrollMemberRuntime(options)
  expect(registered.runtimeID).toBe(ticket.runtime.runtimeID)
  expect(registered.revision).toBe(2)
})

test("registration refuses foreign identity and untrusted TLS before publishing enrollment", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  const ticket = await f.ticket(member.identity.deviceID, member.publicKey)
  const options = { home: member.home, identity: member.identity, ticket }
  await expect(
    enrollMemberRuntime({
      ...options,
      ca: f.ca,
      ticket: { ...ticket, runtime: { ...Protocol.MemberRegistrationRecord.parse(ticket.runtime), accountID: "other" } },
    }),
  ).rejects.toThrow("identity")
  expect(f.requests).toHaveLength(0)
  await expect(enrollMemberRuntime(options)).rejects.toThrow("registration")
  expect(await readMemberRegistration(member.home, member.identity)).toBeUndefined()
  expect(f.requests).toHaveLength(0)
})
