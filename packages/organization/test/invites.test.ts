import { expect, test } from "bun:test"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { fixture, password } from "./support/organization"
import path from "node:path"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { digest } from "../src/auth/secret"
import { organizationOpenApi } from "../src/http"
import { keys, proof, consume, register, connection } from "./support/runtime"

type Client = ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>

test("mounted invitation and self-leave operations keep their strict generated contracts", async () => {
  const spec = await organizationOpenApi()
  expect(spec.paths?.["/org/v1/invites"]?.get?.operationId).toBe("orgInvites.list")
  expect(spec.paths?.["/org/v1/invites/{inviteID}/revoke"]?.post?.operationId).toBe("orgInvites.revoke")
  expect(spec.paths?.["/org/v1/organization/leave"]?.post?.operationId).toBe("orgOrganization.leave")
  expect(spec.paths?.["/org/v1/organization/leave"]?.post?.requestBody).toMatchObject({ required: true })
})

async function join(f: Awaited<ReturnType<typeof fixture>>, issuer: Client, name: string, role = "member") {
  const invitation = await issuer.request("POST", "/invites", { role })
  expect(invitation.status).toBe(200)
  const { token } = (await invitation.json()) as { token: string }
  const response = await f.client().request("POST", "/invites/consume", {
    token,
    requestID: crypto.randomUUID(),
    loginName: name,
    displayName: name,
    password,
  })
  expect(response.status).toBe(200)
  const account = Identity.Account.parse(await response.json())
  const client = f.client()
  await client.login(name)
  return { client, account }
}

test("invitation metadata pages expose independent IDs and only current administrator or issuer access", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const admin = await join(f, owner, "admin", "admin")
  const member = await join(f, owner, "member")
  const invitation = (await (await admin.client.request("POST", "/invites", { role: "member" })).json()) as {
    token: string
  }
  const pages = []
  let cursor: string | undefined
  do {
    const response = await owner.request("GET", `/invites?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      items: { inviteID: string; createdBy: string; revision: number }[]
      cursor?: string
    }
    expect(page.items).toHaveLength(1)
    pages.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  expect(pages).toHaveLength(3)
  expect(new Set(pages.map((item) => item.inviteID)).size).toBe(3)
  expect(JSON.stringify(pages)).not.toContain(invitation.token)
  expect(JSON.stringify(pages)).not.toMatch(/token|hash|password|fingerprint|https?:/i)
  const own = pages.find((item) => item.createdBy === admin.account.accountID)!
  expect(
    (await member.client.request("POST", `/invites/${own.inviteID}/revoke`, { expectedRevision: own.revision })).status,
  ).toBe(404)
  expect((await member.client.request("GET", "/invites")).status).toBe(200)
  expect(await (await member.client.request("GET", "/invites")).json()).toEqual({ items: [] })
  expect(
    (
      await owner.request("PATCH", `/accounts/${admin.account.accountID}`, {
        expectedRevision: admin.account.revision,
        role: "member",
      })
    ).status,
  ).toBe(200)
  await admin.client.login("admin")
  const issued = await admin.client.request("GET", "/invites")
  expect(((await issued.json()) as { items: unknown[] }).items).toHaveLength(1)
  expect(
    (await admin.client.request("POST", `/invites/${own.inviteID}/revoke`, { expectedRevision: own.revision })).status,
  ).toBe(200)
})

test("revocation uses CAS and races invitation consumption without admitting a revoked invitation", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  const page = (await (await owner.request("GET", "/invites")).json()) as {
    items: { inviteID: string; revision: number }[]
  }
  const invite = page.items[0]
  const [revoke, consume] = await Promise.all([
    owner.request("POST", `/invites/${invite.inviteID}/revoke`, { expectedRevision: invite.revision }),
    f.client().request("POST", "/invites/consume", {
      token: invitation.token,
      requestID: crypto.randomUUID(),
      loginName: "race",
      displayName: "Race",
      password,
    }),
  ])
  expect([
    [200, 401],
    [409, 200],
  ]).toContainEqual([revoke.status, consume.status])
  const stale = await owner.request("POST", `/invites/${invite.inviteID}/revoke`, { expectedRevision: invite.revision })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT", currentRevision: invite.revision + 1 })
  await f.restart()
  const current = (await (await owner.request("GET", "/invites")).json()) as { items: { state: string }[] }
  expect(current.items[0].state).toBe(revoke.status === 200 ? "revoked" : "consumed")
})

test("consumption changes invitation revision and cannot be undone by a current administrator", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  await join(f, owner, "joined")
  const page = (await (await owner.request("GET", "/invites")).json()) as {
    items: { inviteID: string; revision: number; state: string }[]
  }
  const invite = page.items[0]
  expect(invite).toMatchObject({ revision: 2, state: "consumed" })
  const revoke = await owner.request("POST", `/invites/${invite.inviteID}/revoke`, {
    expectedRevision: invite.revision,
  })
  expect(revoke.status).toBe(409)
  expect(await revoke.json()).toMatchObject({ code: "TOKEN_CONSUMED" })
})

test("legacy invitations retain their secrets and consumption snapshots through the central metadata migration", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  await f.service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(f.service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    await store.transaction(async (tx) => {
      const invite = await tx.read<Record<string, unknown>>(Keys.invite(digest(invitation.token)))
      expect(invite).toBeDefined()
      delete invite!.inviteID
      delete invite!.orgID
      delete invite!.createdAt
      delete invite!.revision
      invite!.schemaVersion = 1
      await tx.write(Keys.invite(digest(invitation.token)), invite)
      await tx.removeTree(["organization", "invite-catalog"])
      await tx.removeTree(["organization", "issued-invites"])
      await tx.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("organization"), (ledger) => {
        delete ledger["20261111-organization-invitation-catalog"]
      })
    })
  } finally {
    await store.close()
  }
  await f.restart()
  const list = (await (await owner.request("GET", "/invites")).json()) as {
    items: { inviteID: string; revision: number; createdAt?: number }[]
  }
  expect(list.items).toHaveLength(1)
  expect(list.items[0].createdAt).toBeUndefined()
  expect(list.items[0].revision).toBe(1)
  const joinInput = {
    token: invitation.token,
    requestID: crypto.randomUUID(),
    loginName: "legacy",
    displayName: "Legacy",
    password,
  }
  const joined = await f.client().request("POST", "/invites/consume", joinInput)
  expect(joined.status).toBe(200)
  const snapshot = await joined.json()
  await f.restart()
  const replay = await f.client().request("POST", "/invites/consume", joinInput)
  expect(await replay.json()).toEqual(snapshot)
  const again = (await (await owner.request("GET", "/invites")).json()) as {
    items: { inviteID: string; state: string }[]
  }
  expect(again.items[0]).toMatchObject({ inviteID: list.items[0].inviteID, state: "consumed" })
})

test("self leave removes the current account, revokes its logins and preserves the last owner atomically", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const self = Identity.CurrentSession.parse(await (await owner.request("GET", "/auth/session")).json())
  const last = await owner.request("POST", "/organization/leave", { expectedRevision: self.account.revision })
  expect(last.status).toBe(409)
  expect(await last.json()).toMatchObject({ code: "LAST_OWNER" })
  const member = await join(f, owner, "leaver")
  expect(
    (await member.client.request("POST", "/organization/leave", { expectedRevision: member.account.revision + 1 }))
      .status,
  ).toBe(409)
  expect(
    (
      await member.client.request("POST", "/organization/leave", {
        expectedRevision: member.account.revision,
        accountID: self.account.accountID,
      })
    ).status,
  ).toBe(400)
  const results = await Promise.all(
    [0, 1].map(() =>
      member.client.request("POST", "/organization/leave", { expectedRevision: member.account.revision }),
    ),
  )
  expect(results.map((r) => r.status).sort()).toEqual([200, 401])
  expect((await member.client.request("GET", "/auth/session")).status).toBe(401)
  await f.restart()
  expect((await member.client.request("GET", "/auth/session")).status).toBe(401)
  const retained = (await (await owner.request("GET", "/accounts")).json()) as { items: Identity.Account[] }
  expect(retained.items.find((item) => item.accountID === member.account.accountID)?.state).toBe("removed")
  expect(retained.items.find((item) => item.accountID === self.account.accountID)?.role).toBe("owner")
})

test("concurrent owners leaving cannot remove the final owner", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const second = await join(f, owner, "second")
  const promoted = await owner.request("PATCH", `/accounts/${second.account.accountID}`, {
    expectedRevision: second.account.revision,
    role: "owner",
  })
  expect(promoted.status).toBe(200)
  const secondAccount = Identity.Account.parse(await promoted.json())
  await second.client.login("second")
  const self = Identity.CurrentSession.parse(await (await owner.request("GET", "/auth/session")).json())
  const result = await Promise.all([
    owner.request("POST", "/organization/leave", { expectedRevision: self.account.revision }),
    second.client.request("POST", "/organization/leave", { expectedRevision: secondAccount.revision }),
  ])
  expect(result.map((r) => r.status).sort()).toEqual([200, 409])
  expect(await result.find((r) => r.status === 409)!.json()).toMatchObject({ code: "LAST_OWNER" })
})

test("self leave closes the member's real machine connection after the account removal commit", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const member = await join(f, owner, "machine-leaver")
  const key = await keys()
  const ticket = await register(member.client, "leaving-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  const socket = new WebSocket(new URL("/runtime/v1/connect", server.url).toString().replace(/^http/, "ws"))
  const opened = Promise.withResolvers<void>()
  const frame = Promise.withResolvers<unknown>()
  const closed = Promise.withResolvers<CloseEvent>()
  socket.onopen = () => opened.resolve()
  socket.onerror = () => opened.reject(new Error("Machine connection failed"))
  socket.onmessage = (event) => frame.resolve(JSON.parse(String(event.data)))
  socket.onclose = (event) => closed.resolve(event)
  try {
    await opened.promise
    socket.send(JSON.stringify(await connection(runtime, key.privateKey, 1)))
    expect(Runtime.ServerFrame.parse(await frame.promise).type).toBe("handshake")
    expect(
      (await member.client.request("POST", "/organization/leave", { expectedRevision: member.account.revision }))
        .status,
    ).toBe(200)
    expect((await closed.promise).code).toBe(4003)
  } finally {
    socket.close()
    await server.stop(true)
  }
})
