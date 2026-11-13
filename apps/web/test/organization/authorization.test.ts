import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OrganizationClientAuth as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { authorizeOrganization, consumeAuthorizationLocation } from "../../src/organization/authorization"

test("one-time organization onboarding tokens are consumed from the URL before rendering", () => {
  const cleared: string[] = []
  const history = {
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      cleared.push(String(url))
    },
  }
  for (const kind of ["invite", "reset", "setup"] as const) {
    expect(
      consumeAuthorizationLocation(
        { href: `https://org.example/organization.html#${kind}=${"a".repeat(64)}` },
        history,
      ),
    ).toEqual({ kind, token: "a".repeat(64) })
    expect(cleared.at(-1)).toBe("https://org.example/organization.html")
  }
  expect(() =>
    consumeAuthorizationLocation(
      { href: `https://org.example/organization.html#invite=${"a".repeat(64)}&code=other` },
      history,
    ),
  ).toThrow()
  expect(() =>
    consumeAuthorizationLocation({ href: `http://org.example/organization.html#invite=${"a".repeat(64)}` }, history),
  ).toThrow()
})

const authority = { issuer: "https://org.example", orgID: "org", deploymentIncarnation: "incarnation" }
const client = { kind: "web", clientID: "web", redirectUri: "https://app.example/organization.html" } as const
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

function fixture(
  options: { blocked?: boolean; exchange?: () => Promise<void>; response?: Record<string, unknown> } = {},
) {
  const navigated = Promise.withResolvers<URL>()
  const listeners = new Set<(event: MessageEvent) => void>()
  const requests: Request[] = []
  const bodies: unknown[] = []
  const popup = {
    closed: false,
    close() {
      this.closed = true
    },
    location: {
      replace(url: string) {
        navigated.resolve(new URL(url))
      },
    },
  }
  const host = {
    location: { origin: "https://app.example" },
    open: () => (options.blocked ? null : popup),
    addEventListener: (_type: "message", listener: (event: MessageEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: (event: MessageEvent) => void) => listeners.delete(listener),
  }
  const fetcher: typeof fetch = Object.assign(
    async (input: Request | URL | string) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      bodies.push(request.method === "POST" ? await request.clone().json() : undefined)
      if (new URL(request.url).pathname === "/org/v1/auth/discovery")
        return Response.json({ ...authority, client, codeChallengeMethod: "S256" })
      await options.exchange?.()
      return Response.json({
        ...authority,
        clientID: client.clientID,
        account,
        tokenType: "Bearer",
        accessToken: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        ...options.response,
      })
    },
    { preconnect() {} },
  )
  return {
    popup,
    host,
    requests,
    bodies,
    fetcher,
    listeners,
    async opened() {
      const url = await navigated.promise
      const input = Protocol.Authorize.parse(JSON.parse(decodeURIComponent(url.hash.slice("#authorize=".length))))
      return {
        url,
        input,
        code: {
          ...authority,
          clientID: client.clientID,
          redirectUri: client.redirectUri,
          state: input.state,
          code: "b".repeat(64),
          expiresAt: Date.now() + 60_000,
        },
      }
    },
    message(data: unknown, origin = host.location.origin, source: unknown = popup) {
      for (const listener of listeners) listener({ data, origin, source } as MessageEvent)
    },
  }
}

test("a popup transaction binds its exact window, callback, authority and one S256 verifier", async () => {
  const f = fixture()
  const pending = authorizeOrganization({
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    host: f.host,
    fetch: f.fetcher,
  })
  const { input, code, url } = await f.opened()
  expect(url.origin).toBe(authority.issuer)
  expect(url.search).toBe("")
  f.message({ type: "synergy.organization.authorization", code }, "https://other.example")
  f.message({ type: "synergy.organization.authorization", code }, undefined, {})
  f.message({ type: "synergy.organization.authorization", code: { ...code, state: "x".repeat(43) } })
  f.message({ type: "synergy.organization.authorization", code: { ...code, orgID: "other" } })
  expect(f.requests).toHaveLength(1)
  f.message({ type: "synergy.organization.authorization", code })
  f.message({ type: "synergy.organization.authorization", code })
  expect(await pending).toMatchObject({ account, accessToken: "a".repeat(64) })
  expect(f.requests).toHaveLength(2)
  const exchange = f.bodies[1] as Protocol.Exchange
  expect(createHash("sha256").update(exchange.verifier).digest("base64url")).toBe(input.codeChallenge)
  expect(exchange).toMatchObject({
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    code: code.code,
  })
  expect(f.requests.every((request) => request.credentials === "omit" && request.redirect === "error")).toBe(true)
  expect(f.popup.closed).toBe(true)
  expect(f.listeners.size).toBe(0)
})

test("cancellation rejects a late exchange instead of signing in a new page generation", async () => {
  const barrier = Promise.withResolvers<void>()
  const f = fixture({ exchange: () => barrier.promise })
  const abort = new AbortController()
  const pending = authorizeOrganization({
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    host: f.host,
    fetch: f.fetcher,
    signal: abort.signal,
  })
  const rejected = pending.catch((error: unknown) => error)
  const { code } = await f.opened()
  f.message({ type: "synergy.organization.authorization", code })
  abort.abort()
  expect(await rejected).toMatchObject({ code: "cancelled" })
  barrier.resolve()
  expect(f.listeners.size).toBe(0)
  expect(f.popup.closed).toBe(true)
})

test("blocked popups and insecure randomness fail locally without sending credentials", async () => {
  const f = fixture({ blocked: true })
  await expect(
    authorizeOrganization({
      ...authority,
      clientID: client.clientID,
      redirectUri: client.redirectUri,
      host: f.host,
      fetch: f.fetcher,
    }),
  ).rejects.toMatchObject({ code: "popup_unavailable" })
  expect(f.requests).toHaveLength(0)
  const insecure = fixture()
  await expect(
    authorizeOrganization({
      ...authority,
      clientID: client.clientID,
      redirectUri: client.redirectUri,
      host: insecure.host,
      fetch: insecure.fetcher,
      crypto: {},
    }),
  ).rejects.toMatchObject({ code: "secure_context_required" })
  expect(insecure.requests).toHaveLength(0)
  expect(insecure.listeners.size).toBe(0)
})

test("Web rejects refresh secrets and an account or deployment outside the captured authority", async () => {
  for (const response of [
    { refreshToken: "c".repeat(64), refreshExpiresAt: Date.now() + 60_000 },
    { account: { ...account, orgID: "other" } },
    { account: { ...account, accountID: "other" } },
    { deploymentIncarnation: "restored" },
  ]) {
    const f = fixture({ response })
    const pending = authorizeOrganization({
      ...authority,
      accountID: account.accountID,
      clientID: client.clientID,
      redirectUri: client.redirectUri,
      host: f.host,
      fetch: f.fetcher,
    })
    const rejected = pending.catch((error: unknown) => error)
    const { code } = await f.opened()
    f.message({ type: "synergy.organization.authorization", code })
    expect(await rejected).toMatchObject({ code: "invalid_response" })
  }
})

test("callback parsing clears the URL before delivery and rejects callback and issuer confusion", () => {
  const code = {
    ...authority,
    clientID: client.clientID,
    redirectUri: client.redirectUri,
    state: "s".repeat(43),
    code: "b".repeat(64),
    expiresAt: Date.now() + 60_000,
  }
  const cleared: string[] = []
  const history = {
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      cleared.push(String(url))
    },
  }
  const read = (href: string) => consumeAuthorizationLocation({ href }, history)
  const fragment = `#code=${encodeURIComponent(JSON.stringify(code))}`
  expect(read(client.redirectUri + fragment)).toEqual({ kind: "callback", code })
  expect(cleared.at(-1)).toBe(client.redirectUri)
  expect(() => read("https://attacker.example/organization.html" + fragment)).toThrow()
  expect(cleared.at(-1)).toBe("https://attacker.example/organization.html")
  expect(() => read(client.redirectUri + "#code=malformed-private-value")).toThrow("Invalid organization authorization")
  expect(cleared.at(-1)).toBe(client.redirectUri)
  expect(() => read(client.redirectUri + fragment + "&code=duplicate")).toThrow()
})


test("unreachable organization discovery reports connection failure without claiming identity replacement", async () => {
  for (const failure of ["network", "http"] as const) {
    const f = fixture()
    const fetcher: typeof fetch = Object.assign(async () => {
      if (failure === "network") throw new TypeError("Connection closed")
      return Response.json({ code: "UNAVAILABLE" }, { status: 503 })
    }, { preconnect() {} })
    await expect(authorizeOrganization({
      ...authority,
      clientID: client.clientID,
      redirectUri: client.redirectUri,
      host: f.host,
      fetch: fetcher,
    })).rejects.toMatchObject({ code: "unavailable" })
    expect(f.popup.closed).toBe(true)
    expect(f.listeners.size).toBe(0)
  }
})
