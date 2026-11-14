import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import { organizationCommandFixtureSource } from "../support/organization-command-fixture"
import {
  OrganizationApiTokenProtocol as Token,
  OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const connection: Desktop.Connection = {
  id: "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: "https://a.example",
  clientID: "desktop",
  orgID: "org-a",
  deploymentIncarnation: "deployment-a",
  account: {
    accountID: "account-a",
    orgID: "org-a",
    loginName: "member",
    displayName: "Member",
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}
const secret = `sy_api_${"a".repeat(64)}`
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-api-tokens-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {Show} from "solid-js"
    import {AppBaseProviders} from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import {PlatformProvider} from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import {SpaceProvider,useSpace} from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import {OrganizationAccount} from ${JSON.stringify(`/@fs/${source}/organization/account.tsx`)}
    ${organizationCommandFixtureSource}
    const platform={platform:"web",openLink(){},fetch:async()=>Response.json({healthy:false}),organization:{protocolVersion:${Desktop.BridgeVersion},list:()=>window.hostList(),request:value=>window.hostRequest(value),commandStream,cancel:value=>{commandTransfers.delete(value.requestID);return Promise.resolve({ok:true})}}}
    function Fixture(){const space=useSpace();return <Show when={space.current()?.identity.kind === "organization"}><main style={{padding:"16px"}}><OrganizationAccount/></main></Show>}
    render(()=><PlatformProvider value={platform}><AppBaseProviders><SpaceProvider><Fixture/></SpaceProvider></AppBaseProviders></PlatformProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})
const success = (body: unknown) => ({ ok: true, value: { status: 200, body: JSON.stringify(body) } })
async function open(page: Page) {
  await page.goto(new URL("/organization/org-a/account-a/deployment-a", fixture.url).href)
  await page.getByRole("heading", { name: "API tokens", exact: true }).click()
  await page.getByRole("textbox", { name: "Token name", exact: true }).waitFor()
}
async function settings(page: Page) {
  await page.getByRole("textbox", { name: "Token name", exact: true }).fill("Automation")
  await page.getByRole("button", { name: "Project: Choose a project", exact: true }).click()
  await page.getByRole("option", { name: "Field notes", exact: true }).click()
  await page.getByRole("listbox", { name: "Project", exact: true, includeHidden: true }).waitFor({ state: "hidden" })
}
function transport(lost: boolean) {
  const requests: Token.Create[] = []
  let metadata: Token.Metadata | undefined
  return {
    requests,
    async request(input: Desktop.Request) {
      const url = new URL(input.path, connection.issuer)
      if (url.pathname === "/org/v1/projects")
        return success({
          items: [
            {
              projectID: "project-a",
              orgID: "org-a",
              name: "Field notes",
              description: "",
              state: "active",
              revision: 1,
              createdAt: 1,
              role: "collaborator",
              permissions: { read: true, execute: true, manage: false },
            },
          ],
        })
      if (url.pathname === "/org/v1/api-tokens" && input.method === "POST") {
        const value = Token.Create.parse(JSON.parse(input.body!))
        requests.push(value)
        if (!metadata) {
          metadata = {
            tokenID: "token-a",
            orgID: "org-a",
            accountID: "account-a",
            projectID: value.projectID,
            label: value.label,
            operations: value.operations,
            revision: 1,
            createdAt: 1,
            expiresAt: value.expiresAt,
          }
          if (lost)
            return { ok: true, value: { status: 504, body: JSON.stringify({ code: "COMMAND_OUTCOME_UNKNOWN" }) } }
          return success({ metadata, token: secret, secretUnavailable: false })
        }
        return success({ metadata, secretUnavailable: true })
      }
      if (url.pathname === "/org/v1/api-tokens/token-a/revoke") {
        metadata = { ...metadata!, revision: 2, revokedAt: 2 }
        return success(metadata)
      }
      return success({ items: metadata && url.pathname === "/org/v1/api-tokens" ? [metadata] : [] })
    },
  }
}
test("the account token panel reveals an original token once without storing it or issuing again on reload", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 740 } })
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const backend = transport(false)
  await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
  await page.exposeFunction("hostRequest", backend.request)
  try {
    await open(page)
    await settings(page)
    await page.setViewportSize({ width: 360, height: 740 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await page.locator("button,[data-component='checkbox']").evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 1 && rect.height > 1
          })
          .every((element) => {
            const rect = element.getBoundingClientRect()
            return rect.left >= 0 && rect.right <= innerWidth
          }),
      ),
    ).toBe(true)
    if (process.env.SYNERGY_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, "token-360-light-form.png"),
        fullPage: true,
      })
    await page.setViewportSize({ width: 375, height: 740 })
    await page.getByRole("button", { name: "Create token", exact: true }).click()
    await page.getByLabel("API token", { exact: true }).waitFor()
    expect(await page.getByLabel("API token", { exact: true }).inputValue()).toBe(secret)
    expect(await page.getByLabel("API token", { exact: true }).getAttribute("type")).toBe("password")
    await page.getByRole("button", { name: "Copy API token", exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)
    expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(secret)
    expect(backend.requests[0]?.operations).toEqual(["sessions.read"])
    if (process.env.SYNERGY_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, "token-375-light.png"),
        fullPage: true,
      })
    await page.getByRole("button", { name: "Hide token", exact: true }).click()
    expect(await page.getByLabel("API token", { exact: true }).count()).toBe(0)
    await page.reload()
    await page.getByRole("heading", { name: "API tokens", exact: true }).click()
    await page.getByText("Automation", { exact: true }).waitFor()
    expect(await page.getByLabel("API token", { exact: true }).count()).toBe(0)
    expect(backend.requests).toHaveLength(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await page.close()
  }
})
test("lost issuance recovers the original request and requires confirmed revocation before a replacement", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } })
  await page.emulateMedia({ colorScheme: "dark" })
  const backend = transport(true)
  await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
  await page.exposeFunction("hostRequest", backend.request)
  try {
    await open(page)
    await settings(page)
    await page.getByRole("button", { name: "Create token", exact: true }).click()
    await page.getByRole("button", { name: "Recover token issuance", exact: true }).waitFor()
    await page.reload()
    await page.getByRole("heading", { name: "API tokens", exact: true }).click()
    await page.getByRole("button", { name: "Recover token issuance", exact: true }).click()
    await page.getByText(/original value is unavailable/).waitFor()
    if (process.env.SYNERGY_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, "token-900-dark-lost.png"),
        fullPage: true,
      })
    expect(backend.requests).toHaveLength(2)
    expect(backend.requests[1]).toEqual(backend.requests[0])
    expect(await page.getByRole("button", { name: "Create token", exact: true }).count()).toBe(0)
    await page.getByRole("button", { name: "Revoke token", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Revoke token", exact: true }).click()
    await page.getByRole("button", { name: "Create token", exact: true }).waitFor()
    expect(backend.requests).toHaveLength(2)
    expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(secret)
  } finally {
    await page.close()
  }
})
