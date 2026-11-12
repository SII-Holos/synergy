import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
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
    import { Show, createSignal } from "solid-js"
    import { OrganizationProjectMembers } from ${JSON.stringify(`/@fs/${source}/organization/project-members.tsx`)}
    import { OrganizationArtifacts } from ${JSON.stringify(`/@fs/${source}/organization/artifacts.tsx`)}
    import { SpaceProvider, useSpace } from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    const platform = { platform: "web", openLink() {}, organization: { protocolVersion: 2,
      list: () => window.hostList(), request: value => window.hostRequest(value), cancel: value => window.hostCancel(value),
      connect: value => window.hostConnect(value), signOut: value => window.hostSignOut(value),
    }, fetch: async () => Response.json({ healthy: false }) }
    function Probe() { const space = useSpace(); const [project,setProject]=createSignal("project-one"); window.__projectMembersTarget__=setProject; return <Show when={space.current()?.identity.kind === "organization"}><OrganizationProjectMembers projectID={project()} changed={()=>{}} invalidated={()=>{}} /></Show> }
    function Artifacts() { const space = useSpace(); return <Show when={space.current()?.identity.kind === "organization"}><OrganizationArtifacts projectID="project-one" sessionID="session-one" canPublish={true}/></Show> }
    render(() => <PlatformProvider value={platform}><AppBaseProviders>{new URLSearchParams(location.search).get("fixture") === "members" ? <SpaceProvider><Probe /></SpaceProvider> : new URLSearchParams(location.search).get("fixture") === "artifacts" ? <SpaceProvider><Artifacts /></SpaceProvider> : <AppInterface />}</AppBaseProviders></PlatformProvider>, document.getElementById("root"))
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

const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
const resource = {
  resourceID: "team-model",
  orgID: "org-a",
  scope: { kind: "organization" },
  kind: "model",
  name: "Private team model",
  state: "enabled",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  configuration: {
    protocol: "openai-compatible",
    endpoint: "https://models.example/v1",
    model: { id: "team-model", name: "Team model", limit: { context: 128000, output: 8192 } },
  },
  credential: { kind: "bearer" },
}
const project = {
  projectID: "project-one",
  orgID: "org-a",
  name: "Field notes",
  description: "Shared research",
  state: "active",
  revision: 1,
  createdAt: 0,
  permissions: { read: true, manage: true, execute: true },
  role: "maintainer",
}
const knowledge = {
  itemID: "guide",
  orgID: "org-a",
  scope: { kind: "organization" },
  kind: "material",
  title: "Private team guide",
  latestVersion: 1,
  revision: 1,
  state: "published",
  createdAt: 1,
}
const artifact = {
  artifactID: "report",
  orgID: "org-a",
  projectID: "project-one",
  title: "Private project report",
  version: 1,
  revision: 1,
  authorID: "account-a",
  publishedAt: 1,
  manifestHash: "b".repeat(64),
  fileCount: 0,
  totalBytes: 0,
  sourceAvailable: false,
}
const member = {
  ...owner.account,
  accountID: "teammate",
  displayName: "Private teammate",
  loginName: "private-teammate",
  role: "member",
}
function json(body: unknown, status = 200): Desktop.Result<Desktop.Response> {
  return { ok: true, value: { status, body: JSON.stringify(body) } }
}
async function open(
  page: Page,
  destination: string,
  handle: (
    request: Desktop.Request,
    url: URL,
  ) => Desktop.Result<Desktop.Response> | Promise<Desktop.Result<Desktop.Response>>,
) {
  await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const url = new URL(request.path, owner.issuer)
    return url.pathname === "/org/v1/organization"
      ? json({ orgID: "org-a", name: "Field team", revision: 1 })
      : handle(request, url)
  })
  await page.goto(new URL(`/organization/org-a/account-a/deployment-a/${destination}`, server.url).href)
}
async function settled(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}
async function screenshot(page: Page, name: string) {
  if (!process.env.SYNERGY_UI_SCREENSHOT_DIR) return
  await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, name) })
}
const assigned = {
  accountID: "teammate",
  displayName: "Assigned teammate",
  loginName: "assigned",
  state: "active",
  role: "reader",
}
const candidate = { accountID: "candidate", displayName: "Current candidate", loginName: "candidate", state: "active" }
const grant = {
  orgID: "org-a",
  resourceID: resource.resourceID,
  subject: { kind: "account", id: member.accountID },
  enabled: true,
  revision: 1,
  updatedAt: 1,
  updatedBy: "account-a",
}

for (const width of [375, 1100])
  test(`an old project save cannot close a replacement edit at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 667 : 760 } })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>()
    const writes: Desktop.Request[] = []
    try {
      await open(page, "projects/project-one", async (request, url) => {
        if (request.method === "PATCH") {
          writes.push(request)
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ ...project, revision: 2, name: "First accepted edit" })
        }
        if (url.pathname === "/org/v1/projects/project-one") return json(project)
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
      })
      await page.getByRole("button", { name: "Edit project", exact: true }).click()
      await page.getByLabel("Project name", { exact: true }).fill("First accepted edit")
      await page.getByRole("button", { name: "Save changes", exact: true }).click()
      await entered.promise
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Edit project", exact: true }).click()
      await page.getByLabel("Project name", { exact: true }).fill("Replacement project draft")
      release.resolve()
      await delivered.promise
      await settled(page)
      expect(await page.getByLabel("Project name", { exact: true }).count()).toBe(1)
      expect(await page.getByLabel("Project name", { exact: true }).inputValue()).toBe("Replacement project draft")
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0]!.body!)).toMatchObject({ expectedRevision: 1, name: "First accepted edit" })
    } finally {
      release.resolve()
      await page.close()
    }
  }, 30000)

test("closing and reopening project member discovery retires its first pending search", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>()
  let searches = 0
  try {
    await open(page, "projects/project-one/members", async (request, url) => {
      if (url.pathname === "/org/v1/projects/project-one") return json(project)
      if (url.pathname.endsWith("/members")) return json({ items: [assigned], projectRevision: 7 })
      if (url.pathname.endsWith("/member-candidates")) {
        searches++
        if (searches === 1) {
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ items: [{ ...candidate, displayName: "Old candidate" }], projectRevision: 7 })
        }
        return json({ items: [candidate], projectRevision: 8 })
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    })
    await page.getByRole("button", { name: "Add project member", exact: true }).click()
    await entered.promise
    await page.getByRole("button", { name: "Add project member", exact: true }).click()
    await page.getByRole("button", { name: "Add project member", exact: true }).click()
    release.resolve()
    await delivered.promise
    await settled(page)
    expect(searches).toBe(2)
    expect(await page.getByText(candidate.displayName, { exact: true }).count()).toBe(1)
    expect(await page.getByText("Old candidate", { exact: true }).count()).toBe(0)
  } finally {
    release.resolve()
    await page.close()
  }
}, 30000)

test("a project member component cannot retarget or revive after its reactive project changes without disposal", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>()
  const paths: string[] = []
  try {
    await open(page, "?fixture=members", async (request, url) => {
      paths.push(url.pathname)
      if (url.pathname.endsWith("/member-candidates")) {
        entered.resolve()
        await release.promise
        delivered.resolve()
        return json({ items: [candidate], projectRevision: 7 })
      }
      return json({ items: [assigned], projectRevision: 7 })
    })
    await page.getByRole("button", { name: "Add project member", exact: true }).click()
    await entered.promise
    await page.evaluate('window.__projectMembersTarget__("project-two")')
    await settled(page)
    await page.evaluate('window.__projectMembersTarget__("project-one")')
    await settled(page)
    release.resolve()
    await delivered.promise
    await settled(page)
    expect(await page.getByText(assigned.displayName, { exact: true }).count()).toBe(0)
    expect(await page.getByText(candidate.displayName, { exact: true }).count()).toBe(0)
    expect(paths.every((path) => path.includes("/projects/project-one/"))).toBe(true)
  } finally {
    release.resolve()
    await page.close()
  }
}, 30000)

test("project member denial clears its actual parent project and retires the parent's held confirmation", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>()
  const writes: Desktop.Request[] = []
  let recovered = false
  try {
    await open(page, "projects/project-one/members", async (request, url) => {
      if (url.pathname === "/org/v1/projects/project-one") {
        if (request.method === "PATCH") {
          writes.push(request)
          return json({ ...project, revision: 3, state: "archived" })
        }
        return json({ ...project, revision: recovered ? 8 : 7, name: recovered ? "Current project" : project.name })
      }
      if (url.pathname.endsWith("/members")) {
        if (url.searchParams.has("cursor")) {
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ code: "PERMISSION_DENIED", message: "Membership access removed" }, 403)
        }
        return json({ items: [assigned], projectRevision: recovered ? 8 : 7, cursor: "second-page" })
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    })
    await page.getByRole("button", { name: "Load more", exact: true }).click()
    await entered.promise
    await page.getByRole("button", { name: "Archive project", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    release.resolve()
    await delivered.promise
    await settled(page)
    expect(await page.getByRole("dialog").count()).toBe(0)
    expect(await page.getByText(project.name, { exact: true }).count()).toBe(0)
    expect(await page.getByText(assigned.displayName, { exact: true }).count()).toBe(0)
    recovered = true
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByRole("heading", { name: "Current project", exact: true }).waitFor()
    await page.getByRole("button", { name: "Archive project", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Archive project", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 8, state: "archived" })
  } finally {
    release.resolve()
    await page.close()
  }
}, 30000)

test("a project role confirmation retains the project revision observed when it opened", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>()
  const writes: Desktop.Request[] = []
  try {
    await open(page, "projects/project-one/members", async (request, url) => {
      if (url.pathname === "/org/v1/projects/project-one") return json(project)
      if (request.method === "PUT") {
        writes.push(request)
        return json({ code: "REVISION_CONFLICT", message: "Project changed" }, 409)
      }
      if (url.pathname.endsWith("/members")) {
        if (url.searchParams.has("cursor")) {
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ items: [], projectRevision: 8 })
        }
        return json({ items: [assigned], projectRevision: 7, cursor: "second-page" })
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    })
    await page.getByRole("button", { name: "Load more", exact: true }).click()
    await entered.promise
    await page.getByRole("button", { name: "Remove from project", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    release.resolve()
    await delivered.promise
    await settled(page)
    await page.getByRole("dialog").getByRole("button", { name: "Remove from project", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 7, role: null })
  } finally {
    release.resolve()
    await page.close()
  }
}, 30000)

for (const operation of ["read", "write"] as const)
  test(`resource access Members→Projects→Members retires the first ${operation} result`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>()
    let memberReads = 0
    let accountReads = 0
    let writing = false
    try {
      await open(page, "resources", async (request, url) => {
        if (url.pathname === "/org/v1/resources") return json({ items: [resource] })
        if (request.method === "PUT") {
          writing = true
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ ...grant, enabled: true, revision: 2 })
        }
        if (url.pathname === "/org/v1/accounts") {
          accountReads++
          return json({ items: [{ ...member, displayName: accountReads > 1 ? "Current member" : "First member" }] })
        }
        if (url.pathname === "/org/v1/projects") return json({ items: [project] })
        if (url.pathname.includes("/grants")) {
          if (url.pathname.endsWith("/account")) {
            memberReads++
            if (operation === "read" && memberReads === 1) {
              entered.resolve()
              await release.promise
              delivered.resolve()
              return json({ items: [{ ...grant, enabled: false, revision: 1 }] })
            }
            return json({ items: [{ ...grant, revision: writing ? 3 : 2, enabled: operation === "read" }] })
          }
          return json({ items: [] })
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
      })
      await page.getByRole("button", { name: "Manage access", exact: true }).click()
      if (operation === "write") {
        await page.getByRole("button", { name: "Allow use", exact: true }).click()
      }
      await entered.promise
      const selector = page.getByRole("button", { name: /^Manage access:/ })
      await selector.click()
      await page.getByRole("option", { name: "Projects", exact: true }).click()
      await selector.click()
      await page.getByRole("option", { name: "Members", exact: true }).click()
      await page.getByText("Current member", { exact: true }).waitFor()
      release.resolve()
      await delivered.promise
      await settled(page)
      expect(memberReads).toBe(2)
      expect(await page.getByRole("button", { name: "Revoke access", exact: true }).count()).toBe(
        operation === "read" ? 1 : 0,
      )
      expect(await page.getByRole("button", { name: "Allow use", exact: true }).count()).toBe(
        operation === "write" ? 1 : 0,
      )
    } finally {
      release.resolve()
      await page.close()
    }
  }, 30000)

for (const kind of ["knowledge", "artifacts"] as const)
  for (const width of [375, 1100])
    test(`${kind} publication has one active entry and explanation at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 375 ? 667 : 760 } })
      const hint =
        kind === "knowledge"
          ? "Publish a fixed copy for your team. Applied versions change only when a member chooses to update."
          : "Published work stays available to project members independently of the source conversation."
      try {
        await open(page, kind === "knowledge" ? "knowledge" : "?fixture=artifacts", (request, url) => {
          if (url.pathname === "/org/v1/knowledge" || url.pathname.endsWith("/artifacts")) return json({ items: [] })
          throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
        })
        await page.getByRole("button", { name: "Publish", exact: true }).click()
        expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(1)
        expect(await page.getByText(hint, { exact: true }).count()).toBe(1)
        expect(
          await page.getByLabel("Title", { exact: true }).evaluate((field) => field === document.activeElement),
        ).toBe(true)
        await screenshot(page, `${kind}-publication-editing-${width}.png`)
        await page.getByLabel("Title", { exact: true }).fill("Unsent publication")
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        expect(
          await page
            .getByRole("button", { name: "Publish", exact: true })
            .evaluate((button) => button === document.activeElement),
        ).toBe(true)
        expect(await page.getByText(hint, { exact: true }).count()).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await screenshot(page, `${kind}-publication-${width}.png`)
      } finally {
        await page.close()
      }
    }, 30000)
