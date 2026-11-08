import { expect, test } from "bun:test"
import { randomBytes, createHash } from "node:crypto"
import { DesktopOrganizationAuthorization } from "../src/organization/authorization"
import { DesktopOrganizationIPC } from "../src/organization/ipc"
import { organizationFixture } from "./fixture/organization"

async function authorized(f: Awaited<ReturnType<typeof organizationFixture>>) {
  const verifier = randomBytes(32).toString("base64url")
  const { issuer, orgID, deploymentIncarnation } = f.info
  const request = {
    issuer,
    orgID,
    deploymentIncarnation,
    clientID: "desktop",
    redirectUri: "synergy://organization-auth/callback",
    state: randomBytes(32).toString("base64url"),
    codeChallengeMethod: "S256" as const,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
  }
  const code = await f.consent(request)
  const result = await f.api.orgAuth.exchange(
    {
      orgCodeExchangeInput: {
        issuer,
        orgID,
        deploymentIncarnation,
        clientID: "desktop",
        redirectUri: request.redirectUri,
        code: code.code,
        verifier,
      },
    },
    { throwOnError: true },
  )
  return f.accounts.accept(result.data)
}
function bridge(f: Awaited<ReturnType<typeof organizationFixture>>, fetcher = f.transport) {
  const trusted = {}
  const authorization = new DesktopOrganizationAuthorization({
    accounts: f.accounts,
    fetch: fetcher,
    openExternal: async () => {},
  })
  const ipc = new DesktopOrganizationIPC({
    accounts: f.accounts,
    authorization,
    fetch: fetcher,
    trusted: (event) => event === trusted,
  })
  return { trusted, ipc }
}

test("organization IPC rejects untrusted frames and credential or arbitrary-target requests", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  let calls = 0
  const { trusted, ipc } = bridge(f, (async (...args: Parameters<typeof fetch>) => {
    calls++
    return f.transport(...args)
  }) as typeof fetch)
  for (const action of ["list", "request", "connect", "signOut", "cancel"] as const)
    expect(await ipc.handle({}, action, {})).toEqual({ ok: false, error: { code: "untrusted_sender" } })
  const base = { requestID: "request-a", connectionID: connection.id, method: "GET", path: "/org/v1/projects" }
  for (const changed of [
    { path: "https://other.example/org/v1/projects" },
    { path: "//other.example/org/v1/projects" },
    { path: "/org/v1/projects/../../auth/exchange" },
    { path: "/org/v1/projects%2f../auth/exchange" },
    { path: "/org/v1/auth/refresh", method: "POST" },
    { path: "/runtime/v1/register", method: "POST" },
    { path: "/org/v1/runtimes/member", method: "POST" },
    { path: "/org/v1/invites/consume", method: "POST" },
    { path: "/org/v1/projects#credential" },
    { headers: { authorization: "injected" } },
    { body: "{}" },
    { method: "POST", body: "invalid-json" },
    { method: "POST", body: JSON.stringify("x".repeat(65_536)) },
  ])
    expect(await ipc.handle(trusted, "request", { ...base, ...changed })).toEqual({
      ok: false,
      error: { code: "invalid_request" },
    })
  expect(calls).toBe(0)
  expect(await ipc.handle(trusted, "list", undefined)).toEqual({ ok: true, value: [connection] })
  ipc.dispose()
})

test("the native organization bridge preserves generated SDK results and never repeats a rejected write", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const requests: Request[] = []
  const { trusted, ipc } = bridge(f, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    return f.transport(request)
  }) as typeof fetch)
  const created = await ipc.handle(trusted, "request", {
    requestID: "create",
    connectionID: connection.id,
    method: "POST",
    path: "/org/v1/projects",
    body: JSON.stringify({ name: "Native client" }),
  })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error("Project creation failed")
  expect(created.value).toMatchObject({ status: 200 })
  expect(JSON.stringify(created)).not.toContain("accessToken")
  expect(requests[0]!.headers.get("authorization")).toMatch(/^Bearer [a-f0-9]{64}$/)
  expect(requests[0]!.headers.has("cookie")).toBe(false)
  expect(requests[0]!.redirect).toBe("error")
  await f.accounts.signOut(connection.id)
  const denied = await ipc.handle(trusted, "request", {
    requestID: "denied",
    connectionID: connection.id,
    method: "POST",
    path: "/org/v1/projects",
    body: JSON.stringify({ name: "Should not be sent" }),
  })
  expect(denied).toEqual({ ok: false, error: { code: "signed_out" } })
  expect(requests).toHaveLength(1)
  ipc.dispose()
})

test("navigation cancels native requests and duplicate transport request IDs cannot repeat a write", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  const { trusted, ipc } = bridge(f, (async (input: RequestInfo | URL) => {
    const request = input as Request
    signal = request.signal
    entered.resolve()
    return response.promise
  }) as typeof fetch)
  const request = {
    requestID: "pending",
    connectionID: connection.id,
    method: "POST",
    path: "/org/v1/projects",
    body: '{"name":"Pending"}',
  }
  const pending = ipc.handle(trusted, "request", request)
  await entered.promise
  expect(await ipc.handle(trusted, "request", request)).toEqual({ ok: false, error: { code: "request_in_progress" } })
  ipc.invalidate()
  expect(signal?.aborted).toBe(true)
  response.resolve(Response.json({ late: true }))
  expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } })
  expect((await ipc.handle(trusted, "list", undefined)).ok).toBe(true)
  ipc.dispose()
})

test("native responses retain structured API errors and reject redirects or oversized and non-JSON bodies", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  let response = Response.json(
    { code: "AUTHENTICATION_REQUIRED", outcome: "not_dispatched", retryable: false },
    { status: 401 },
  )
  let calls = 0
  const { trusted, ipc } = bridge(f, (async () => {
    calls++
    return response
  }) as typeof fetch)
  const request = { requestID: "request", connectionID: connection.id, method: "GET", path: "/org/v1/projects" }
  const denied = await ipc.handle(trusted, "request", request)
  expect(denied).toMatchObject({ ok: true, value: { status: 401 } })
  expect(calls).toBe(1)
  for (const value of [
    new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    new Response("<html>invalid</html>", { headers: { "content-type": "text/html" } }),
    Response.json({ content: "x".repeat(2_097_152) }),
  ]) {
    response = value
    expect(await ipc.handle(trusted, "request", request)).toEqual({ ok: false, error: { code: "invalid_response" } })
  }
  ipc.dispose()
})
