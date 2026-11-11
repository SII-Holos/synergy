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

test("shared transcript windows and runtime availability use exact main-authenticated read paths", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  let calls = 0
  const { trusted, ipc } = bridge(
    f,
    Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        expect(request.headers.get("authorization")).toStartWith("Bearer ")
        calls++
        return Response.json({ items: [] })
      },
      { preconnect() {} },
    ),
  )
  for (const [index, [method, path]] of (
    [
      ["GET", "/org/v1/sessions/session-one/sync/messages?limit=32"],
      ["GET", "/org/v1/sessions/session-one/sync/messages/message-one/parts?limit=64"],
      ["GET", "/org/v1/runtimes/runtime-one/connection"],
      ["GET", "/org/v1/sessions/session-one/knowledge/status"],
      ["PUT", "/org/v1/sessions/session-one/share"],
      ["GET", "/org/v1/invites?limit=50"],
      ["POST", "/org/v1/invites/invite-one/revoke"],
      ["POST", "/org/v1/organization/leave"],
      ["POST", "/org/v1/sessions/session-one/read"],
    ] as const
  ).entries()) {
    const result = await ipc.handle(trusted, "request", {
      requestID: `read-${index}`,
      connectionID: connection.id,
      method,
      path,
      ...(method === "PUT" ? { body: '{"expectedShareGeneration":0}' } : {}),
    })
    expect(result).toMatchObject({ ok: true, value: { status: 200 } })
  }
  expect(calls).toBe(9)
  ipc.dispose()
})

test("organization IPC rejects untrusted frames and credential or arbitrary-target requests", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  let calls = 0
  const { trusted, ipc } = bridge(f, (async (...args: Parameters<typeof fetch>) => {
    calls++
    return f.transport(...args)
  }) as typeof fetch)
  for (const action of [
    "list",
    "request",
    "connect",
    "signOut",
    "cancel",
    "memberStatus",
    "startMember",
    "download",
  ] as const)
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

test("member process requests require a main-owned Runtime registry and reject caller-selected launch inputs", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const { trusted, ipc } = bridge(f)
  try {
    expect(await ipc.handle(trusted, "memberStatus", { connectionID: connection.id })).toEqual({
      ok: false,
      error: { code: "unavailable" },
    })
    expect(
      await ipc.handle(trusted, "startMember", {
        requestID: "start-member",
        connectionID: connection.id,
        home: "/untrusted-home",
        token: "renderer-supplied-credential",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_request" } })
  } finally {
    ipc.dispose()
  }
})

test("the organization bridge exposes the resource directory through main-owned credentials", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const { trusted, ipc } = bridge(f)
  try {
    const result = await ipc.handle(trusted, "request", {
      requestID: "resources",
      connectionID: connection.id,
      method: "GET",
      path: "/org/v1/resources?limit=20",
    })
    expect(result).toMatchObject({ ok: true, value: { status: 200 } })
    if (!result.ok) throw new Error("Resource directory was not admitted")
    expect(JSON.stringify(result.value)).not.toContain("accessToken")
  } finally {
    ipc.dispose()
  }
})

test("native blob chunks retain exact bytes and reject ranges or byte bodies on control routes", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const bytes = new Uint8Array([0, 255, 128, 10])
  const received: Request[] = []
  const { trusted, ipc } = bridge(f, (async (input: RequestInfo | URL) => {
    const request = input as Request
    received.push(request)
    if (request.method === "PUT") return Response.json({ offset: 4 })
    return new Response(bytes, {
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-3/8" },
    })
  }) as typeof fetch)
  const base = {
    requestID: "blob",
    connectionID: connection.id,
    method: "GET",
    path: `/org/v1/sessions/session/blobs/${"b".repeat(64)}/content`,
    range: "bytes=0-3",
  }
  try {
    expect(await ipc.handle(trusted, "request", base)).toEqual({
      ok: true,
      value: { status: 206, bodyBytes: bytes, contentType: "application/octet-stream", contentRange: "bytes 0-3/8" },
    })
    expect(received[0]?.headers.get("range")).toBe("bytes=0-3")
    expect(received[0]?.headers.get("authorization")).toMatch(/^Bearer [a-f0-9]{64}$/)
    const upload = await ipc.handle(trusted, "request", {
      ...base,
      requestID: "upload",
      method: "PUT",
      path: `/org/v1/sessions/session/blobs/${"b".repeat(64)}?offset=0&totalBytes=4`,
      range: undefined,
      bodyBytes: bytes,
      contentType: "application/octet-stream",
    })
    expect(upload).toMatchObject({ ok: true, value: { status: 200 } })
    expect(new Uint8Array(await received[1]!.arrayBuffer())).toEqual(bytes)
    for (const changed of [
      { path: "/org/v1/projects" },
      {
        method: "POST",
        path: "/org/v1/projects",
        range: undefined,
        bodyBytes: bytes,
        contentType: "application/octet-stream",
      },
    ]) {
      expect(await ipc.handle(trusted, "request", { ...base, ...changed })).toEqual({
        ok: false,
        error: { code: "invalid_request" },
      })
    }
    expect(received).toHaveLength(2)
  } finally {
    ipc.dispose()
  }
})

test("native downloads stream only authorized immutable content and verify its digest before publishing", async () => {
  await using f = await organizationFixture()
  const connection = await authorized(f)
  const bytes = new Uint8Array([0, 255, 128, 10])
  const chunks: Uint8Array[] = []
  let empty = false
  const trusted = {}
  const ipc = new DesktopOrganizationIPC({
    accounts: f.accounts,
    authorization: new DesktopOrganizationAuthorization({
      accounts: f.accounts,
      fetch: f.transport,
      openExternal: async () => {},
    }),
    trusted: (event) => event === trusted,
    fetch: (async () =>
      new Response(empty ? null : bytes, {
        headers: { "content-type": "application/octet-stream", "content-length": empty ? "0" : "4" },
      })) as typeof fetch,
    saveFile: async (_name, write) => ({
      saved: true,
      bytes: await write(async (chunk) => {
        chunks.push(chunk)
      }),
    }),
  })
  const request = {
    requestID: "download",
    connectionID: connection.id,
    path: `/org/v1/sessions/session/blobs/${"b".repeat(64)}/content`,
    fileName: "evidence.bin",
    bytes: 4,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
  try {
    expect(await ipc.handle(trusted, "download", request)).toEqual({ ok: true, value: { saved: true, bytes: 4 } })
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
    expect(
      await ipc.handle(trusted, "download", { ...request, requestID: "bad-digest", sha256: "a".repeat(64) }),
    ).toEqual({ ok: false, error: { code: "invalid_response" } })
    expect(await ipc.handle(trusted, "download", { ...request, path: "/org/v1/projects" })).toEqual({
      ok: false,
      error: { code: "invalid_request" },
    })
    empty = true
    expect(
      await ipc.handle(trusted, "download", {
        ...request,
        requestID: "empty",
        bytes: 0,
        sha256: createHash("sha256").digest("hex"),
      }),
    ).toEqual({ ok: true, value: { saved: true, bytes: 0 } })
  } finally {
    ipc.dispose()
  }
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
