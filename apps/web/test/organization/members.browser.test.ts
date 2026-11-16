import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

let browser: Browser
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const entries: Desktop.Connection[] = ["a", "b"].map((id) => ({
  id: id.repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: `https://${id}.example`,
  clientID: "desktop",
  orgID: `org-${id}`,
  deploymentIncarnation: `deployment-${id}`,
  account: {
    accountID: `account-${id}`,
    orgID: `org-${id}`,
    loginName: id,
    displayName: `Member ${id.toUpperCase()}`,
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}))

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-space-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    const platform = { platform: "web", openLink() {}, organization: { protocolVersion: 2,
      list: () => window.hostList(), request: value => window.hostRequest(value), cancel: value => window.hostCancel(value),
      connect: value => window.hostConnect(value), signOut: value => window.hostSignOut(value),
    }, fetch: async () => Response.json({ healthy: false }) }
    render(() => <PlatformProvider value={platform}><AppBaseProviders><AppInterface /></AppBaseProviders></PlatformProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test("an administrator creates a one-time reset link with the observed account revision and keeps it out of storage", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
  const member = {
    ...owner.account,
    accountID: "teammate",
    displayName: "Teammate",
    loginName: "teammate",
    role: "member",
    revision: 4,
  }
  const writes: Desktop.Request[] = []
  const token = "c".repeat(64)
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") writes.push(request)
    const body =
      request.path === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : request.method === "POST"
          ? { token, expiresAt: Date.now() + 3600_000 }
          : { items: [owner.account, member] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })

  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a/members", server.url).href)
    await page
      .getByRole("listitem")
      .filter({ hasText: "Teammate" })
      .getByRole("button", { name: "Reset password", exact: true })
      .click()
    expect(writes).toHaveLength(0)
    await page.getByRole("button", { name: "Create reset link", exact: true }).click()
    const field = page.getByRole("textbox", { name: "Password reset link", exact: true })
    await field.waitFor()
    expect(await field.inputValue()).toBe(`https://a.example/organization.html#reset=${token}`)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("/org/v1/accounts/teammate/reset")
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 4 })
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token)
    expect(page.url()).not.toContain(token)
  } finally {
    await page.close()
  }
}, 30_000)

test("the account page revokes an invitation with its observed revision and self-leave remains a separate confirmed action", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
  const writes: Desktop.Request[] = []
  const invite = {
    inviteID: "invitation-a",
    createdBy: owner.account.accountID,
    createdAt: 1,
    expiresAt: Date.now() + 3600_000,
    role: "member",
    revision: 7,
    state: "open",
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") writes.push(request)
    const pathname = new URL(request.path, owner.issuer).pathname
    const response =
      pathname === "/org/v1/invites"
        ? { items: [invite] }
        : pathname === "/org/v1/auth/session"
          ? {
              account: { ...owner.account, revision: 4 },
              csrfToken: "c".repeat(64),
              expiresAt: Date.now() + 3600_000,
            }
          : request.path.endsWith("/revoke")
            ? { ...invite, state: "revoked", revision: 8 }
            : request.path.endsWith("/leave")
              ? {
                  code: "LAST_OWNER",
                  message: "The last owner cannot leave",
                  outcome: "not_dispatched",
                  retryable: false,
                }
              : { orgID: "org-a", name: "Field team", revision: 1 }
    return {
      ok: true,
      value: { status: request.path.endsWith("/leave") ? 409 : 200, body: JSON.stringify(response) },
    }
  })

  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a/account", server.url).href)
    await page.getByRole("button", { name: "Revoke invitation", exact: true }).click()
    expect(writes).toHaveLength(0)
    await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation", exact: true }).click()
    await page.getByText("Revoked", { exact: true }).waitFor()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("/org/v1/invites/invitation-a/revoke")
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 7 })
    await page.getByRole("button", { name: "Leave organization", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Leave organization", exact: true }).click()
    await page
      .getByText("Transfer ownership to another member before leaving this organization.", { exact: true })
      .waitFor()
    expect(writes[1]?.path).toBe("/org/v1/organization/leave")
    expect(JSON.parse(writes[1]!.body!)).toEqual({ expectedRevision: 4 })
    expect(page.url()).toContain("/account")
    expect(writes.some((request) => request.path.includes("logout"))).toBe(false)
  } finally {
    await page.close()
  }
})

test("ownership transfer uses the organization revision independently of the owner's account revision", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const, revision: 2 } }
  const target = {
    ...owner.account,
    accountID: "successor",
    loginName: "successor",
    displayName: "Successor",
    role: "member",
    revision: 7,
  }
  const writes: Desktop.Request[] = []
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") writes.push(request)
    const body =
      request.method === "POST"
        ? { ok: true }
        : request.path === "/org/v1/organization"
          ? { orgID: "org-a", name: "Field team", revision: 13 }
          : { items: [owner.account, target] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a/members", server.url).href)
    await page
      .getByRole("listitem")
      .filter({ hasText: "Successor" })
      .getByRole("button", { name: "Transfer ownership", exact: true })
      .click()
    expect(writes).toHaveLength(0)
    await page.getByRole("dialog").getByRole("button", { name: "Transfer ownership", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.body!)).toEqual({
      accountID: "successor",
      expectedRevision: 13,
      targetRevision: 7,
    })
  } finally {
    await page.close()
  }
})
