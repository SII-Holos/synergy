import { expect, test } from "bun:test"
import { createOrganizationApproval } from "../../src/organization/approval"

const request = {
  issuer: "https://org.example",
  orgID: "org",
  deploymentIncarnation: "deployment",
  clientID: "web",
  redirectUri: "https://client.example/organization.html",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
} as const
const account = {
  accountID: "member",
  orgID: "org",
  loginName: "member",
  displayName: "Member",
  role: "member",
  state: "active",
  revision: 1,
  authRevision: 1,
  createdAt: 0,
} as const
const session = { account, csrfToken: "a".repeat(64), expiresAt: Date.now() + 60_000 }

function fixture(
  options: {
    discovery?: Record<string, unknown>
    sessionStatus?: number
    authorize?: Record<string, unknown>
    logoutStatus?: number
  } = {},
) {
  const calls: Array<{ path: string; request: Request; body?: unknown }> = []
  const fetcher: typeof fetch = Object.assign(
    async (input: Request | URL | string) => {
      const req = input instanceof Request ? input : new Request(input)
      const path = new URL(req.url).pathname
      calls.push({
        path,
        request: req,
        body: req.headers.get("content-type")?.includes("application/json") ? await req.clone().json() : undefined,
      })
      if (path.endsWith("/discovery"))
        return Response.json({
          issuer: request.issuer,
          orgID: request.orgID,
          deploymentIncarnation: request.deploymentIncarnation,
          client: { kind: "web", clientID: request.clientID, redirectUri: request.redirectUri },
          codeChallengeMethod: "S256",
          ...options.discovery,
        })
      if (path.endsWith("/session")) return Response.json(session, { status: options.sessionStatus ?? 200 })
      if (path.endsWith("/login")) return Response.json(session)
      if (path.endsWith("/logout")) return Response.json({ ok: true }, { status: options.logoutStatus ?? 200 })
      if (path.endsWith("/authorize"))
        return Response.json({
          issuer: request.issuer,
          orgID: request.orgID,
          deploymentIncarnation: request.deploymentIncarnation,
          clientID: request.clientID,
          redirectUri: request.redirectUri,
          state: request.state,
          code: "b".repeat(64),
          expiresAt: Date.now() + 60_000,
          ...options.authorize,
        })
      return new Response(null, { status: 404 })
    },
    { preconnect() {} },
  )
  return { calls, api: createOrganizationApproval({ request, origin: request.issuer, fetch: fetcher }) }
}

test("first-party approval reuses a valid cookie session and authorizes only after an explicit action", async () => {
  const f = fixture()
  expect(await f.api.load()).toEqual(session)
  expect(f.calls.map((call) => call.path)).toEqual(["/org/v1/auth/discovery", "/org/v1/auth/session"])
  const callback = new URL(await f.api.approve())
  expect(callback.origin + callback.pathname).toBe(request.redirectUri)
  expect(callback.search).toBe("")
  expect(JSON.parse(decodeURIComponent(callback.hash.slice("#code=".length)))).toMatchObject({
    state: request.state,
    code: "b".repeat(64),
  })
  expect(f.calls[2].request.headers.get("x-csrf-token")).toBe(session.csrfToken)
  expect(f.calls[2].body).toEqual(request)
  expect(f.calls.every((call) => call.request.credentials === "same-origin" && call.request.redirect === "error")).toBe(
    true,
  )
})

test("expired sessions require login, and logout prevents reuse of the former CSRF authority", async () => {
  const f = fixture({ sessionStatus: 401 })
  expect(await f.api.load()).toBeUndefined()
  await expect(f.api.approve()).rejects.toMatchObject({ code: "sign_in_required" })
  expect(await f.api.login({ loginName: "member", password: "secret" })).toEqual(session)
  expect(f.calls.at(-1)?.body).toEqual({ loginName: "member", password: "secret" })
  await f.api.logout()
  expect(f.calls.at(-1)?.request.headers.get("x-csrf-token")).toBe(session.csrfToken)
  await expect(f.api.approve()).rejects.toMatchObject({ code: "sign_in_required" })
})

test("wrong issuers and altered registration fail before cookie requests or a redirect", async () => {
  expect(() => createOrganizationApproval({ request, origin: "https://attacker.example" })).toThrow()
  for (const discovery of [
    { orgID: "other" },
    { deploymentIncarnation: "restored" },
    { client: { kind: "web", clientID: "web", redirectUri: "https://attacker.example/organization.html" } },
  ]) {
    const f = fixture({ discovery })
    await expect(f.api.load()).rejects.toMatchObject({ code: "invalid_request" })
    expect(f.calls).toHaveLength(1)
    await expect(f.api.login({ loginName: "member", password: "secret" })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(f.calls).toHaveLength(1)
  }
  const changed = fixture({ authorize: { redirectUri: "https://attacker.example/organization.html" } })
  await changed.api.load()
  await expect(changed.api.approve()).rejects.toMatchObject({ code: "invalid_response" })
})

test("connection failures do not masquerade as password expiry", async () => {
  const f = fixture({ sessionStatus: 503 })
  await expect(f.api.load()).rejects.toMatchObject({ code: "unavailable" })
})

test("a failed logout retains the authority for an explicit retry, while an already revoked login is signed out", async () => {
  const configuration = { logoutStatus: 503 }
  const f = fixture(configuration)
  await f.api.load()
  await expect(f.api.logout()).rejects.toMatchObject({ code: "unavailable" })
  configuration.logoutStatus = 401
  await f.api.logout()
  expect(f.calls.filter((call) => call.path.endsWith("/logout"))).toHaveLength(2)
  await expect(f.api.approve()).rejects.toMatchObject({ code: "sign_in_required" })
})
