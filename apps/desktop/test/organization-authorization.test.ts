import { expect, test } from "bun:test"
import { OrganizationClientAuth as Auth } from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationAuthorization } from "../src/organization/authorization"
import { organizationFixture } from "./fixture/organization"

function callback(code: ReturnType<typeof Auth.Code.parse>) {
  return `synergy://organization-auth/callback#code=${encodeURIComponent(JSON.stringify(code))}`
}
function opener() {
  const opened = Promise.withResolvers<Auth.Authorize>()
  return {
    opened: opened.promise,
    async openExternal(url: string) {
      const address = new URL(url)
      expect(address.origin + address.pathname).toBe("https://organization.example/organization.html")
      expect(address.search).toBe("")
      opened.resolve(Auth.Authorize.parse(JSON.parse(new URLSearchParams(address.hash.slice(1)).get("authorize")!)))
    },
  }
}

test("native authorization exchanges a real PKCE code, persists a sealed credential and revokes the originating login", async () => {
  await using f = await organizationFixture()
  const host = opener()
  const auth = new DesktopOrganizationAuthorization({
    accounts: f.accounts,
    fetch: f.transport,
    openExternal: host.openExternal,
  })
  const result = auth.authorize({ issuer: f.info.issuer, clientID: "desktop" })
  const request = await host.opened
  const code = await f.consent(request)
  expect(await auth.callback(callback(code))).toBe(true)
  const connection = await result
  expect(connection.account.accountID).toBe(f.account.accountID)
  expect(JSON.stringify(connection)).not.toContain("Token")
  expect(await auth.callback(callback(code))).toBe(true)
  const recovered = f.restart()
  const access = await recovered.access(connection.id)
  expect(
    (await f.api.orgAuth.session({ headers: { authorization: `Bearer ${access.accessToken}` } })).response.status,
  ).toBe(200)
  await recovered.signOut(connection.id)
  expect(
    (await f.api.orgAuth.session({ headers: { authorization: `Bearer ${access.accessToken}` } })).response.status,
  ).toBe(401)
  expect((await f.restart().list())[0]!.state).toBe("signed_out")
  auth.dispose()
})

test("native callbacks require the exact target, transaction and authority without consuming another code", async () => {
  await using f = await organizationFixture()
  const host = opener()
  const auth = new DesktopOrganizationAuthorization({
    accounts: f.accounts,
    fetch: f.transport,
    openExternal: host.openExternal,
  })
  const result = auth.authorize({ issuer: f.info.issuer, clientID: "desktop" })
  const code = await f.consent(await host.opened)
  expect(await auth.callback("synergy://session/task")).toBe(false)
  for (const address of [
    callback(code).replace("/callback#", "/callback?unexpected=1#"),
    callback(code).replace("organization-auth/", "user@organization-auth/"),
    callback(code).replace("/callback#", "/different#"),
    callback(code) + "&code=duplicate",
    callback({ ...code, state: "x".repeat(43) }),
    callback({ ...code, issuer: "https://different.example" }),
    callback({ ...code, deploymentIncarnation: "different" }),
    callback({ ...code, clientID: "different" }),
  ])
    expect(await auth.callback(address)).toBe(true)
  expect(await f.accounts.list()).toEqual([])
  await auth.callback(callback(code))
  expect((await result).state).toBe("ready")
  auth.dispose()
})

test("navigation cancellation rejects late native exchange and preserves the account store", async () => {
  await using f = await organizationFixture()
  const host = opener()
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const response = await f.transport(request)
    if (request.url.endsWith("/exchange")) {
      entered.resolve()
      await resume.promise
    }
    return response
  }) as typeof fetch
  const auth = new DesktopOrganizationAuthorization({
    accounts: f.accounts,
    fetch: transport,
    openExternal: host.openExternal,
  })
  const controller = new AbortController()
  const result = auth.authorize({ issuer: f.info.issuer, clientID: "desktop" }, { signal: controller.signal })
  const rejected = result.catch((error: unknown) => error)
  const code = await f.consent(await host.opened)
  const completion = auth.callback(callback(code))
  await entered.promise
  controller.abort()
  resume.resolve()
  await completion
  expect(await rejected).toMatchObject({ code: "cancelled" })
  expect(await f.accounts.list()).toEqual([])
  expect(await auth.callback(callback(code))).toBe(true)
  auth.dispose()
})

test("known deployment and account bindings reject discovery changes and an unexpected browser login", async () => {
  await using f = await organizationFixture()
  const host = opener()
  const auth = new DesktopOrganizationAuthorization({
    accounts: f.accounts,
    fetch: f.transport,
    openExternal: host.openExternal,
  })
  await expect(
    auth.authorize({
      issuer: f.info.issuer,
      clientID: "desktop",
      expected: { orgID: f.info.orgID, deploymentIncarnation: "different" },
    }),
  ).rejects.toMatchObject({ code: "identity_changed" })
  const result = auth.authorize({
    issuer: f.info.issuer,
    clientID: "desktop",
    expected: {
      orgID: f.info.orgID,
      deploymentIncarnation: f.info.deploymentIncarnation,
      accountID: "different-account",
    },
  })
  const rejected = result.catch((error: unknown) => error)
  await auth.callback(callback(await f.consent(await host.opened)))
  expect(await rejected).toMatchObject({ code: "identity_changed" })
  expect(await f.accounts.list()).toEqual([])
  auth.dispose()
})
