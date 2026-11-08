import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { organizationOpenApi } from "../src/http"
import { openOrganizationService } from "../src/service"
import { OrganizationClientAuth as Protocol, OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { fixture, password } from "./support/organization"

const issuer = "https://organization.example"
const web = { clientID: "web", kind: "web" as const, redirectUri: "https://work.example/organization/callback" }
const desktop = {
  clientID: "desktop",
  kind: "desktop" as const,
  redirectUri: "synergy://organization-auth/callback" as const,
}
const clients = { clients: [web, desktop] }
function proof() {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Browser = ReturnType<Fixture["client"]>

function request(
  f: Fixture,
  route: string,
  options: { body?: unknown; token?: string; origin?: string; method?: string } = {},
) {
  return f.service.fetch(
    new Request(`${issuer}/org/v1${route}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

async function authorize(f: Fixture, owner: Browser, client: Protocol.Client = desktop) {
  const deployment = await f.service.deployment()
  const authority = { issuer, orgID: deployment.orgID, deploymentIncarnation: deployment.deploymentIncarnation }
  const transaction = proof()
  const input: Protocol.Authorize = {
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    codeChallenge: transaction.codeChallenge,
    codeChallengeMethod: "S256",
    state: transaction.state,
  }
  const response = await owner.request("POST", "/auth/authorize", input)
  expect(response.status).toBe(200)
  const code = Protocol.Code.parse(await response.json())
  const exchange: Protocol.Exchange = {
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    code: code.code,
    verifier: transaction.verifier,
  }
  return { authority, input, exchange, code }
}

async function tokens(f: Fixture, owner: Browser, client: Protocol.Client = desktop) {
  const grant = await authorize(f, owner, client)
  const response = await request(f, "/auth/exchange", { body: grant.exchange })
  expect(response.status).toBe(200)
  return { ...grant, tokens: Protocol.Tokens.parse(await response.json()) }
}

test("PKCE authorization binds the client and current login, exchanges once, and revokes derived access on logout", async () => {
  await using f = await fixture(undefined, { clientAuthentication: clients })
  const owner = await f.initialize()
  const deployment = await f.service.deployment()
  const authority = { issuer, orgID: deployment.orgID, deploymentIncarnation: deployment.deploymentIncarnation }
  const transaction = proof()
  const requested = {
    ...authority,
    clientID: web.clientID,
    redirectUri: web.redirectUri,
    codeChallenge: transaction.codeChallenge,
    codeChallengeMethod: "S256",
    state: transaction.state,
  }
  const issued = await owner.request("POST", "/auth/authorize", requested)
  expect(issued.status).toBe(200)
  const authorization = await issued.json()
  expect(authorization).toMatchObject({
    ...authority,
    clientID: web.clientID,
    redirectUri: web.redirectUri,
    state: transaction.state,
  })
  const exchange = async (body: unknown) =>
    f.service.fetch(
      new Request(`${issuer}/org/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://work.example" },
        body: JSON.stringify(body),
      }),
    )
  const input = {
    ...authority,
    clientID: web.clientID,
    redirectUri: web.redirectUri,
    code: authorization.code,
    verifier: transaction.verifier,
  }
  expect((await exchange({ ...input, verifier: proof().verifier })).status).toBe(401)
  expect((await exchange({ ...input, clientID: desktop.clientID, redirectUri: desktop.redirectUri })).status).toBe(401)
  const races = await Promise.all([exchange(input), exchange(input)])
  expect(races.map((result) => result.status).sort()).toEqual([200, 401])
  const tokens = await races.find((result) => result.status === 200)!.json()
  expect(tokens).toMatchObject({ ...authority, clientID: web.clientID, tokenType: "Bearer" })
  expect(tokens.refreshToken).toBeUndefined()
  const authenticated = (origin = "https://work.example") =>
    f.service.fetch(
      new Request(`${issuer}/org/v1/projects`, { headers: { authorization: `Bearer ${tokens.accessToken}`, origin } }),
    )
  expect((await authenticated()).status).toBe(200)
  expect((await authenticated("https://attacker.example")).status).toBe(403)
  await f.restart()
  expect((await authenticated()).status).toBe(200)
  expect((await owner.request("POST", "/auth/logout", {})).status).toBe(200)
  expect((await authenticated()).status).toBe(401)
  expect((await owner.request("POST", "/auth/authorize", requested)).status).toBe(401)
})

test("Desktop refresh rotates once and replay durably revokes the whole grant without revoking another client", async () => {
  await using f = await fixture(undefined, { clientAuthentication: clients })
  const owner = await f.initialize()
  const native = await tokens(f, owner)
  const browser = await tokens(f, owner, web)
  expect(native.tokens.refreshToken).toBeDefined()
  const refresh: Protocol.Refresh = {
    ...native.authority,
    clientID: desktop.clientID,
    refreshToken: native.tokens.refreshToken!,
  }
  expect((await request(f, "/auth/refresh", { body: { ...refresh, clientID: web.clientID } })).status).toBe(401)
  const rotated = await request(f, "/auth/refresh", { body: refresh })
  expect(rotated.status).toBe(200)
  const next = Protocol.Tokens.parse(await rotated.json())
  expect(next.refreshToken).not.toBe(refresh.refreshToken)
  expect((await request(f, "/projects", { token: next.accessToken })).status).toBe(200)
  await f.restart()
  expect((await request(f, "/auth/refresh", { body: refresh })).status).toBe(401)
  await f.restart()
  for (const accessToken of [native.tokens.accessToken, next.accessToken])
    expect((await request(f, "/projects", { token: accessToken })).status).toBe(401)
  expect((await request(f, "/auth/refresh", { body: { ...refresh, refreshToken: next.refreshToken } })).status).toBe(
    401,
  )
  expect(
    (await request(f, "/projects", { token: browser.tokens.accessToken, origin: "https://work.example" })).status,
  ).toBe(200)
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
})

test("exact clients and origins constrain discovery, authorization, preflight and bearer credentials", async () => {
  await using f = await fixture(undefined, { clientAuthentication: clients })
  const owner = await f.initialize()
  const grant = await tokens(f, owner, web)
  const discovery = await request(f, "/auth/discovery?clientID=web", { origin: "https://work.example" })
  expect(discovery.status).toBe(200)
  expect(Protocol.Discovery.parse(await discovery.json())).toEqual({
    ...grant.authority,
    client: web,
    codeChallengeMethod: "S256",
  })
  const preflight = await request(f, "/auth/exchange", { method: "OPTIONS", origin: "https://work.example" })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://work.example")
  expect(preflight.headers.get("access-control-allow-credentials")).toBeNull()
  expect(preflight.headers.get("access-control-allow-headers")).not.toContain("X-CSRF-Token")
  expect((await request(f, "/auth/exchange", { method: "OPTIONS", origin: "https://attacker.example" })).status).toBe(
    403,
  )
  expect((await request(f, "/auth/discovery?clientID=unknown")).status).toBe(401)
  expect(
    (await owner.request("POST", "/auth/authorize", { ...grant.input, redirectUri: web.redirectUri + "/" })).status,
  ).toBe(403)
  expect(
    (await owner.request("POST", "/auth/authorize", { ...grant.input, codeChallengeMethod: "plain" })).status,
  ).toBe(400)
  expect(
    (
      await request(f, "/auth/authorize", {
        token: grant.tokens.accessToken,
        body: grant.input,
        origin: "https://work.example",
      })
    ).status,
  ).toBe(403)
  const login = await owner.login("owner")
  const cookieToken = login.headers.get("set-cookie")!.split(";")[0].split("=")[1]
  expect((await request(f, "/projects", { token: cookieToken })).status).toBe(401)
  const native = await tokens(f, owner)
  expect(
    (await request(f, "/projects", { token: native.tokens.accessToken, origin: "https://work.example" })).status,
  ).toBe(403)
  const rejected = await request(f, "/auth/exchange", {
    body: { ...grant.exchange, unexpected: "synthetic-hidden-secret" },
  })
  expect(rejected.status).toBe(400)
  expect(await rejected.text()).not.toContain("synthetic-hidden-secret")
  expect(
    (await request(f, "/auth/logout", { body: {}, token: grant.tokens.accessToken, origin: "https://work.example" }))
      .status,
  ).toBe(200)
  expect((await request(f, "/projects", { token: grant.tokens.accessToken })).status).toBe(401)
})

test("codes reject organization mix-up and current account revocation before exchange", async () => {
  await using first = await fixture(undefined, { clientAuthentication: clients })
  await using second = await fixture(undefined, { clientAuthentication: clients })
  const owner = await first.initialize()
  await second.initialize()
  const grant = await authorize(first, owner)
  expect((await request(second, "/auth/exchange", { body: grant.exchange })).status).toBe(401)
  for (const field of ["issuer", "orgID", "deploymentIncarnation"] as const) {
    const value = field === "issuer" ? "https://different.example" : crypto.randomUUID()
    expect((await request(first, "/auth/exchange", { body: { ...grant.exchange, [field]: value } })).status).toBe(401)
  }
  const active = await tokens(first, owner)
  expect(
    (
      await owner.request("POST", "/auth/password", {
        currentPassword: password,
        password: "another sufficiently long password",
      })
    ).status,
  ).toBe(200)
  expect((await request(first, "/auth/exchange", { body: grant.exchange })).status).toBe(401)
  expect((await request(first, "/projects", { token: active.tokens.accessToken })).status).toBe(401)
  expect(
    (
      await request(first, "/auth/refresh", {
        body: { ...active.authority, clientID: desktop.clientID, refreshToken: active.tokens.refreshToken },
      })
    ).status,
  ).toBe(401)
  await owner.login("owner", "another sufficiently long password")
  const invite = OrganizationIdentity.TokenResult.parse(
    await (await owner.request("POST", "/invites", { role: "member" })).json(),
  )
  const member = first.client()
  const account = OrganizationIdentity.Account.parse(
    await (
      await member.request("POST", "/invites/consume", {
        token: invite.token,
        requestID: crypto.randomUUID(),
        loginName: "member",
        displayName: "Member",
        password,
      })
    ).json(),
  )
  await member.login("member")
  const removed = await authorize(first, member)
  expect(
    (
      await owner.request("PATCH", `/accounts/${account.accountID}`, {
        expectedRevision: account.revision,
        state: "removed",
      })
    ).status,
  ).toBe(200)
  expect((await request(first, "/auth/exchange", { body: removed.exchange })).status).toBe(401)
})

test("changing the registered client invalidates issued codes and grants after restart", async () => {
  const configuration = { clients: [web, desktop] }
  await using f = await fixture(undefined, { clientAuthentication: configuration })
  const owner = await f.initialize()
  const grant = await tokens(f, owner, web)
  const pending = await authorize(f, owner, web)
  configuration.clients = [{ ...web, redirectUri: "https://work.example/different-callback" }, desktop]
  await f.restart()
  expect((await request(f, "/projects", { token: grant.tokens.accessToken })).status).toBe(401)
  expect((await request(f, "/auth/exchange", { body: pending.exchange })).status).toBe(401)
  const native = await tokens(f, owner)
  configuration.clients = []
  await f.restart()
  expect((await request(f, "/projects", { token: native.tokens.accessToken })).status).toBe(401)
  expect(
    (
      await request(f, "/auth/refresh", {
        body: { ...native.authority, clientID: desktop.clientID, refreshToken: native.tokens.refreshToken },
      })
    ).status,
  ).toBe(401)
})

test("authorization codes, access tokens and Desktop refresh tokens honor their configured expiry", async () => {
  await using codeFixture = await fixture(undefined, { clientAuthentication: { ...clients, codeMs: 10 } })
  const code = await authorize(codeFixture, await codeFixture.initialize())
  await Bun.sleep(Math.max(1, code.code.expiresAt - Date.now() + 1))
  expect((await request(codeFixture, "/auth/exchange", { body: code.exchange })).status).toBe(401)
  await using accessFixture = await fixture(undefined, { clientAuthentication: { ...clients, accessMs: 10 } })
  const access = await tokens(accessFixture, await accessFixture.initialize())
  await Bun.sleep(Math.max(1, access.tokens.expiresAt - Date.now() + 1))
  expect((await request(accessFixture, "/projects", { token: access.tokens.accessToken })).status).toBe(401)
  await using refreshFixture = await fixture(undefined, { clientAuthentication: { ...clients, refreshMs: 10 } })
  const refresh = await tokens(refreshFixture, await refreshFixture.initialize())
  await Bun.sleep(Math.max(1, refresh.tokens.refreshExpiresAt! - Date.now() + 1))
  expect(
    (
      await request(refreshFixture, "/auth/refresh", {
        body: { ...refresh.authority, clientID: desktop.clientID, refreshToken: refresh.tokens.refreshToken },
      })
    ).status,
  ).toBe(401)
})

test("persisted client authentication records contain no bearer secrets or PKCE verifier", async () => {
  await using f = await fixture(undefined, { clientAuthentication: clients })
  const grant = await tokens(f, await f.initialize())
  await f.service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(f.service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    const records = await store.query({ prefix: ["organization"], limit: 100 })
    const serialized = JSON.stringify(records.map((record) => record.value))
    for (const secret of [
      grant.code.code,
      grant.exchange.verifier,
      grant.tokens.accessToken,
      grant.tokens.refreshToken!,
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain(grant.input.codeChallenge)
  } finally {
    await store.close()
  }
})

test("the generated client performs discovery, authorization, exchange and refresh over real HTTP", async () => {
  await using f = await fixture(undefined, { clientAuthentication: clients })
  const owner = await f.initialize()
  const login = await owner.login("owner")
  const current = OrganizationIdentity.CurrentSession.parse(await (await owner.request("GET", "/auth/session")).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch })
  try {
    const client = createOrganizationClient({ baseUrl: server.url.toString() })
    const discovery = (await client.orgAuth.discovery({ clientID: desktop.clientID }, { throwOnError: true })).data
    const authority = {
      issuer: discovery.issuer,
      orgID: discovery.orgID,
      deploymentIncarnation: discovery.deploymentIncarnation,
    }
    const transaction = proof()
    const code = (
      await client.orgAuth.authorize(
        {
          orgAuthorizeInput: {
            ...authority,
            clientID: desktop.clientID,
            redirectUri: desktop.redirectUri,
            codeChallenge: transaction.codeChallenge,
            codeChallengeMethod: "S256",
            state: transaction.state,
          },
        },
        {
          throwOnError: true,
          headers: {
            origin: issuer,
            cookie: login.headers.get("set-cookie")!.split(";")[0],
            "x-csrf-token": current.csrfToken,
          },
        },
      )
    ).data
    const grant = (
      await client.orgAuth.exchange(
        {
          orgCodeExchangeInput: {
            ...authority,
            clientID: desktop.clientID,
            redirectUri: desktop.redirectUri,
            code: code.code,
            verifier: transaction.verifier,
          },
        },
        { throwOnError: true },
      )
    ).data
    const next = (
      await client.orgAuth.refresh(
        { orgTokenRefreshInput: { ...authority, clientID: desktop.clientID, refreshToken: grant.refreshToken! } },
        { throwOnError: true },
      )
    ).data
    const headers = { authorization: `Bearer ${next.accessToken}` }
    const project = (
      await client.orgProjects.create(
        { orgProjectCreate: { name: "Authorized from Desktop" } },
        { headers, throwOnError: true },
      )
    ).data
    expect(project.permissions.execute).toBe(true)
    expect((await client.orgAuth.session({ headers, throwOnError: true })).data.expiresAt).toBe(next.expiresAt)
    const logout = await client.orgAuth.logout({ orgEmptyInput: {} }, { headers })
    expect(logout.response.status).toBe(200)
    expect(logout.data).toEqual({ ok: true })
    expect((await client.orgAuth.session({ headers })).response.status).toBe(401)
    const spec = await organizationOpenApi()
    expect(spec.paths?.["/org/v1/auth/discovery"]?.get?.operationId).toBe("orgAuth.discovery")
    for (const action of ["authorize", "exchange", "refresh"]) {
      expect(spec.paths?.[`/org/v1/auth/${action}`]?.post?.operationId).toBe(`orgAuth.${action}`)
      expect(spec.paths?.[`/org/v1/auth/${action}`]?.post?.requestBody).toMatchObject({ required: true })
    }
  } finally {
    await server.stop(true)
  }
})

test("invalid client configuration refuses startup before writing an organization Home", async () => {
  await using f = await fixture()
  const home = path.join(f.service.home, "invalid-client-service")
  await expect(openOrganizationService({ home, clientAuthentication: clients })).rejects.toThrow("public origin")
  for (const redirectUri of [
    "not-a-url",
    "http://work.example/callback",
    "https://work.example/callback?target=unregistered",
    "https://work.example/callback#fragment",
    "https://user@work.example/callback",
  ]) {
    await expect(
      openOrganizationService({
        home,
        publicOrigin: issuer,
        clientAuthentication: { clients: [{ ...web, redirectUri }] },
      }),
    ).rejects.toThrow()
  }
  await expect(
    openOrganizationService({ home, publicOrigin: issuer, clientAuthentication: { clients: [web, web] } }),
  ).rejects.toThrow("unique")
  await expect(fs.access(home)).rejects.toThrow()
})
