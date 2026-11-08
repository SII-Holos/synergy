import { expect, test } from "bun:test"
import path from "node:path"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { fixture, password } from "./support/organization"

test("bootstrap and invite consumption are atomic and replay only the identical logical request", async () => {
  const f = await fixture()
  const token = await f.service.bootstrapToken()
  const anonymous = f.client()
  const input = {
    token,
    requestID: crypto.randomUUID(),
    organizationName: "Team",
    loginName: "Owner",
    displayName: "Owner",
    password,
  }
  const initialized = await Promise.all([0, 1].map(() => anonymous.request("POST", "/setup/bootstrap", input)))
  expect(initialized.map((r) => r.status)).toEqual([200, 200])
  const accounts = await Promise.all(initialized.map((r) => r.json()))
  expect(accounts[0]).toEqual(accounts[1])
  expect(
    (
      await anonymous.request("POST", "/setup/bootstrap", {
        ...input,
        requestID: crypto.randomUUID(),
        loginName: "impostor",
      })
    ).status,
  ).toBe(409)
  await expect(f.service.bootstrapToken()).rejects.toThrow("initialized")
  const owner = f.client()
  await owner.login(" owner ")
  const invitation = await owner.request("POST", "/invites", { role: "member" })
  expect(invitation.status).toBe(200)
  const invite = (await invitation.json()) as { token: string }
  const join = {
    token: invite.token,
    requestID: crypto.randomUUID(),
    loginName: "member",
    displayName: "Member",
    password,
  }
  const joined = await Promise.all([0, 1].map(() => anonymous.request("POST", "/invites/consume", join)))
  expect(joined.map((r) => r.status)).toEqual([200, 200])
  const originalMember = (await joined[0].json()) as { accountID: string; revision: number }
  expect(originalMember).toEqual(await joined[1].json())
  expect(
    (
      await owner.request("PATCH", `/accounts/${originalMember.accountID}`, {
        expectedRevision: originalMember.revision,
        displayName: "Renamed",
      })
    ).status,
  ).toBe(200)
  expect(await (await anonymous.request("POST", "/invites/consume", join)).json()).toEqual(originalMember)
  expect(
    (
      await anonymous.request("POST", "/invites/consume", {
        ...join,
        requestID: crypto.randomUUID(),
        loginName: "intruder",
      })
    ).status,
  ).toBe(409)
  expect((await anonymous.request("POST", "/invites/consume", { ...join, displayName: "Changed" })).status).toBe(409)
})

test("login cookies enforce Origin and CSRF, logout and password change revoke existing sessions", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const second = f.client()
  const login = await second.login("owner")
  const cookie = login.headers.get("set-cookie")!
  expect(cookie).toContain("Secure")
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Lax")
  expect(cookie.startsWith("__Host-")).toBe(true)
  expect(
    (await owner.request("POST", "/projects", { name: "Denied" }, { origin: "https://attacker.example" })).status,
  ).toBe(403)
  expect((await owner.request("POST", "/projects", { name: "Denied" }, { "x-csrf-token": "wrong" })).status).toBe(403)
  expect(
    (await owner.request("POST", "/auth/password", { currentPassword: password, password: "new long secret password" }))
      .status,
  ).toBe(200)
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  expect((await second.request("GET", "/auth/session")).status).toBe(401)
  expect((await f.client().request("POST", "/auth/login", { loginName: "owner", password })).status).toBe(401)
  await owner.login("owner", "new long secret password")
  expect((await owner.request("POST", "/auth/logout", {})).status).toBe(200)
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  expect(
    (
      await f
        .client()
        .request(
          "POST",
          "/auth/login",
          { loginName: "owner", password: "new long secret password" },
          { origin: "https://attacker.example" },
        )
    ).status,
  ).toBe(403)
})

async function member(
  f: Awaited<ReturnType<typeof fixture>>,
  owner: ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>,
  loginName: string,
  role = "member",
) {
  const invite = (await (await owner.request("POST", "/invites", { role })).json()) as { token: string }
  const client = f.client()
  const response = await client.request("POST", "/invites/consume", {
    token: invite.token,
    requestID: crypto.randomUUID(),
    loginName,
    displayName: loginName,
    password,
  })
  expect(response.status).toBe(200)
  await client.login(loginName)
  return client
}

test("last-owner protection serializes role changes and retains removed account attribution", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const other = await member(f, owner, "successor")
  const first = (await (await owner.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  const target = (await (await other.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  const failures = await Promise.all([
    owner.request("PATCH", `/accounts/${first.account.accountID}`, {
      expectedRevision: first.account.revision,
      role: "member",
    }),
    owner.request("PATCH", `/accounts/${first.account.accountID}`, {
      expectedRevision: first.account.revision,
      state: "removed",
    }),
  ])
  expect(failures.map((r) => r.status)).toEqual([409, 409])
  const organization = (await (await owner.request("GET", "/organization")).json()) as { revision: number }
  expect(
    (
      await owner.request("POST", "/organization/transfer-owner", {
        accountID: target.account.accountID,
        expectedRevision: organization.revision,
        targetRevision: target.account.revision,
      })
    ).status,
  ).toBe(200)
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  await owner.login("owner")
  await other.login("successor")
  const current = (await (await other.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  expect(
    (
      await owner.request("PATCH", `/accounts/${current.account.accountID}`, {
        expectedRevision: current.account.revision,
        state: "removed",
      })
    ).status,
  ).toBe(403)
  const old = (await (await owner.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  expect(
    (
      await other.request("PATCH", `/accounts/${old.account.accountID}`, {
        expectedRevision: old.account.revision,
        state: "removed",
      })
    ).status,
  ).toBe(200)
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  const accounts = (await (await other.request("GET", "/accounts")).json()) as {
    items: Array<{ accountID: string; state: string }>
  }
  expect(accounts.items.find((a) => a.accountID === old.account.accountID)?.state).toBe("removed")
})

test("project roles are independent, administrator access never implies execution, archive preserves roles", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const collaborator = await member(f, owner, "collaborator")
  const admin = await member(f, owner, "admin", "admin")
  const account = (await (await collaborator.request("GET", "/auth/session")).json()) as {
    account: { accountID: string }
  }
  const p = (await (await owner.request("POST", "/projects", { name: "Writable" })).json()) as {
    projectID: string
    revision: number
  }
  const q = (await (await owner.request("POST", "/projects", { name: "Readable" })).json()) as {
    projectID: string
    revision: number
  }
  expect(
    (
      await owner.request("PUT", `/projects/${p.projectID}/members/${account.account.accountID}`, {
        role: "collaborator",
        expectedRevision: p.revision,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await owner.request("PUT", `/projects/${q.projectID}/members/${account.account.accountID}`, {
        role: "reader",
        expectedRevision: q.revision,
      })
    ).status,
  ).toBe(200)
  const allowed = (await (await collaborator.request("GET", `/projects/${p.projectID}`)).json()) as {
    permissions: { execute: boolean }
    revision: number
  }
  const readOnly = (await (await collaborator.request("GET", `/projects/${q.projectID}`)).json()) as {
    permissions: { execute: boolean }
  }
  const administrator = (await (await admin.request("GET", `/projects/${p.projectID}`)).json()) as {
    permissions: { execute: boolean }
  }
  expect(allowed.permissions.execute).toBe(true)
  expect(readOnly.permissions.execute).toBe(false)
  expect(administrator.permissions.execute).toBe(false)
  expect(
    (
      await collaborator.request("PATCH", `/projects/${p.projectID}`, {
        state: "archived",
        expectedRevision: allowed.revision,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await owner.request("PATCH", `/projects/${p.projectID}`, {
        state: "archived",
        expectedRevision: allowed.revision,
      })
    ).status,
  ).toBe(200)
  const archived = (await (await collaborator.request("GET", `/projects/${p.projectID}`)).json()) as {
    state: string
    permissions: { execute: boolean }
    revision: number
  }
  expect(archived.state).toBe("archived")
  expect(archived.permissions.execute).toBe(false)
  expect(
    (await owner.request("PATCH", `/projects/${p.projectID}`, { state: "active", expectedRevision: allowed.revision }))
      .status,
  ).toBe(409)
  expect(
    (await owner.request("PATCH", `/projects/${p.projectID}`, { state: "active", expectedRevision: archived.revision }))
      .status,
  ).toBe(200)
  expect(
    (
      await collaborator.request("PATCH", `/projects/${p.projectID}`, {
        projectID: q.projectID,
        expectedRevision: archived.revision,
      })
    ).status,
  ).toBe(400)
  const invalid = await collaborator.request("PATCH", `/projects/${p.projectID}`, {
    actor: "owner",
    expectedRevision: archived.revision,
  })
  expect(await invalid.json()).toMatchObject({ code: "INVALID_REQUEST", outcome: "not_dispatched", retryable: false })
})

test("reset links are one-time, preserve idempotent retry, revoke every previous login and protect owners", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const target = await member(f, owner, "reset-target")
  const admin = await member(f, owner, "reset-admin", "admin")
  const session = (await (await target.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  const ownerSession = (await (await owner.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  expect(
    (
      await admin.request("POST", `/accounts/${ownerSession.account.accountID}/reset`, {
        expectedRevision: ownerSession.account.revision,
      })
    ).status,
  ).toBe(403)
  const link = (await (
    await owner.request("POST", `/accounts/${session.account.accountID}/reset`, {
      expectedRevision: session.account.revision,
    })
  ).json()) as { token: string }
  const input = { token: link.token, requestID: crypto.randomUUID(), password: "reset to another long secret" }
  const responses = await Promise.all([0, 1].map(() => f.client().request("POST", "/auth/reset", input)))
  expect(responses.map((r) => r.status)).toEqual([200, 200])
  expect((await target.request("GET", "/auth/session")).status).toBe(401)
  expect((await f.client().request("POST", "/auth/reset", { ...input, requestID: crypto.randomUUID() })).status).toBe(
    409,
  )
  await target.login("reset-target", input.password)
})

test("two owners cannot concurrently remove each other and transfer to a removed account fails atomically", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const target = await member(f, owner, "second-owner")
  const a = (await (await owner.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  const b = (await (await target.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; revision: number }
  }
  const promoted = (await (
    await owner.request("PATCH", `/accounts/${b.account.accountID}`, {
      expectedRevision: b.account.revision,
      role: "owner",
    })
  ).json()) as { revision: number }
  await target.login("second-owner")
  const responses = await Promise.all([
    owner.request("PATCH", `/accounts/${b.account.accountID}`, {
      expectedRevision: promoted.revision,
      state: "removed",
    }),
    target.request("PATCH", `/accounts/${a.account.accountID}`, {
      expectedRevision: a.account.revision,
      state: "removed",
    }),
  ])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401])
  const survivor = responses[0].status === 200 ? owner : target
  const dead = responses[0].status === 200 ? b.account.accountID : a.account.accountID
  const accounts = (await (await survivor.request("GET", "/accounts")).json()) as {
    items: Array<{ accountID: string; revision: number; state: string; role: string }>
  }
  expect(accounts.items.filter((a) => a.state === "active" && a.role === "owner")).toHaveLength(1)
  const organization = (await (await survivor.request("GET", "/organization")).json()) as { revision: number }
  expect(
    (
      await survivor.request("POST", "/organization/transfer-owner", {
        accountID: dead,
        expectedRevision: organization.revision,
        targetRevision: accounts.items.find((a) => a.accountID === dead)!.revision,
      })
    ).status,
  ).toBe(409)
  expect(await (await survivor.request("GET", "/organization")).json()).toEqual(organization)
})

test("same normalized login is unique per organization and never merges across organizations", async () => {
  const first = await fixture()
  const second = await fixture()
  const a = await first.initialize("ＳＡＭＥ")
  const b = await second.initialize("same")
  const one = (await (await a.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; orgID: string }
  }
  const two = (await (await b.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; orgID: string }
  }
  expect(one.account.orgID).not.toBe(two.account.orgID)
  expect(one.account.accountID).not.toBe(two.account.accountID)
  const invitation = (await (await a.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  expect(
    (
      await first.client().request("POST", "/invites/consume", {
        token: invitation.token,
        requestID: crypto.randomUUID(),
        loginName: " SAME ",
        displayName: "Duplicate",
        password,
      })
    ).status,
  ).toBe(409)
})

test("credentials remain hashed at rest and revocation survives restart", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const login = await owner.login("owner")
  const secret = login.headers.get("set-cookie")!.split(";")[0].split("=")[1]
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  await f.service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(f.service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    const records = await store.query({ prefix: ["organization"], limit: 100 })
    const serialized = JSON.stringify(records.map((record) => record.value))
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(invitation.token)
    expect(serialized).toContain("$argon2id$v=19$m=65536,t=3,")
  } finally {
    await store.close()
  }
  await f.restart()
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
  expect((await owner.request("POST", "/auth/logout", {})).status).toBe(200)
  await f.restart()
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
})

test("expired initialization, invitations and login sessions refuse admission", async () => {
  const expiringBootstrap = await fixture({ bootstrapMs: 1 })
  const bootstrap = await expiringBootstrap.service.bootstrapToken()
  expect(
    (
      await expiringBootstrap.client().request("POST", "/setup/bootstrap", {
        token: bootstrap,
        requestID: crypto.randomUUID(),
        organizationName: "Expired",
        loginName: "owner",
        displayName: "Owner",
        password,
      })
    ).status,
  ).toBe(401)
  const f = await fixture({ inviteMs: 1 })
  const owner = await f.initialize()
  const invite = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  expect(
    (
      await f.client().request("POST", "/invites/consume", {
        token: invite.token,
        requestID: crypto.randomUUID(),
        loginName: "late",
        displayName: "Late",
        password,
      })
    ).status,
  ).toBe(401)
  const expiringLogin = await fixture({ loginMs: 1 })
  const signedIn = await expiringLogin.initialize()
  await Bun.sleep(3)
  expect((await signedIn.request("GET", "/auth/session")).status).toBe(401)
})

test("malformed credential bodies return structured errors without echoing secrets", async () => {
  const f = await fixture()
  const secret = "synthetic secret that must not appear in a response"
  const response = await f
    .client()
    .request("POST", "/auth/login", { loginName: "owner", password: secret, actor: "forged" })
  expect(response.status).toBe(400)
  const body = await response.text()
  expect(body).not.toContain(secret)
  expect(body).not.toContain("forged")
  expect(JSON.parse(body)).toMatchObject({
    code: "INVALID_REQUEST",
    outcome: "not_dispatched",
    requestID: response.headers.get("x-request-id"),
  })
})

test("project pagination includes only the caller's current memberships before applying the limit", async () => {
  const f = await fixture()
  const owner = await f.initialize()
  const reader = await member(f, owner, "paged-reader")
  const account = (await (await reader.request("GET", "/auth/session")).json()) as { account: { accountID: string } }
  const expected = new Set<string>()
  for (let index = 0; index < 130; index++) {
    const project = (await (await owner.request("POST", "/projects", { name: `Project ${index}` })).json()) as {
      projectID: string
      revision: number
    }
    if (index % 3 === 0) continue
    expected.add(project.projectID)
    expect(
      (
        await owner.request("PUT", `/projects/${project.projectID}/members/${account.account.accountID}`, {
          role: "reader",
          expectedRevision: project.revision,
        })
      ).status,
    ).toBe(200)
  }
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await reader.request("GET", `/projects?limit=17${cursor ? `&cursor=${cursor}` : ""}`)
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: Array<{ projectID: string }>; cursor?: string }
    for (const item of page.items) {
      expect(expected.has(item.projectID)).toBe(true)
      expect(seen.has(item.projectID)).toBe(false)
      seen.add(item.projectID)
    }
    cursor = page.cursor
  } while (cursor)
  expect(seen).toEqual(expected)
  const id = [...seen][0]
  const current = (await (await owner.request("GET", `/projects/${id}`)).json()) as { revision: number }
  expect(
    (
      await owner.request("PUT", `/projects/${id}/members/${account.account.accountID}`, {
        role: null,
        expectedRevision: current.revision,
      })
    ).status,
  ).toBe(200)
  expect((await reader.request("GET", `/projects/${id}`)).status).toBe(404)
  const largePage = (await (await owner.request("GET", "/projects?limit=100")).json()) as {
    items: unknown[]
    cursor?: string
  }
  expect(largePage.items).toHaveLength(100)
  expect(largePage.cursor).toBeDefined()
}, 30000)
