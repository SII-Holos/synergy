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
    const platform = { platform: "web", openLink() {}, organization: {
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

test("an organization owner creates a project through the shared shell without personal service access", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
  const writes: Desktop.Request[] = []
  const project = {
    projectID: "project-new",
    orgID: "org-a",
    name: "Field notes",
    description: "Shared research",
    state: "active",
    revision: 1,
    createdAt: 0,
    permissions: { read: true, manage: true, execute: true },
    role: "maintainer",
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") writes.push(request)
    const body =
      request.path === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : request.method === "POST" || request.path.includes("/projects/project-new")
          ? project
          : { items: [] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(server.url)
    await page.getByRole("button", { name: "Current space" }).click()
    await page.getByRole("menuitem", { name: /a.example.*Member A/ }).click()
    await page.getByRole("button", { name: "Create project", exact: true }).click()
    await page.getByLabel("Project name").fill("Field notes")
    await page.getByLabel("Description", { exact: true }).fill("Shared research")
    await page.getByRole("button", { name: "Create project", exact: true }).click()
    await page.getByRole("heading", { name: "Field notes", exact: true }).waitFor()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("/org/v1/projects")
    expect(JSON.parse(writes[0]!.body!)).toEqual({ name: "Field notes", description: "Shared research" })
    expect(page.url()).toContain("/projects/project-new")
  } finally {
    await page.close()
  }
}, 30_000)

test("an administrator configures a model without retaining its credential in the resource view", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
  const writes: Desktop.Request[] = []
  const resource = {
    resourceID: "resource-model",
    orgID: "org-a",
    scope: { kind: "organization" },
    kind: "model",
    name: "Team model",
    state: "enabled",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    configuration: {
      protocol: "openai-compatible",
      model: { id: "team-model", name: "Team model", limit: { context: 128000, output: 8192 } },
      endpoint: "https://models.example/v1",
    },
    credential: { kind: "bearer" },
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") writes.push(request)
    const body =
      request.path === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : request.method === "POST"
          ? resource
          : { items: writes.length ? [resource] : [] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a/resources", server.url).href)
    await page.getByRole("button", { name: "Add resource", exact: true }).click()
    await page.getByLabel("Resource name").fill("Team model")
    await page.getByLabel("Endpoint", { exact: true }).fill("https://models.example/v1")
    await page.getByLabel("Model ID").fill("team-model")
    await page.getByLabel("API key", { exact: true }).fill("fixture-private-key")
    await page.getByRole("button", { name: "Save resource", exact: true }).click()
    await page.getByText("Team model", { exact: true }).first().waitFor()
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.body!).credential).toEqual({ kind: "bearer", value: "fixture-private-key" })
    expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0)
    expect(await page.locator("body").innerText()).not.toContain("fixture-private-key")
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fixture-private-key")
  } finally {
    await page.close()
  }
}, 30_000)
