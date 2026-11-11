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

test("a member explicitly applies a historical release without changing other fixed versions", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const writes: Desktop.Request[] = []
  const project = {
    projectID: "project-one",
    orgID: "org-a",
    name: "Field notes",
    description: "Shared research",
    state: "active",
    revision: 1,
    createdAt: 0,
    permissions: { read: true, manage: false, execute: true },
    role: "collaborator",
  }
  const item = {
    itemID: "guide",
    orgID: "org-a",
    scope: { kind: "project", projectID: "project-one" },
    kind: "material",
    title: "Field guidelines",
    authorID: "account-b",
    state: "published",
    revision: 3,
    latestVersion: 3,
    createdAt: 1,
    updatedAt: 3,
  }
  let selected = {
    revision: 2,
    manifestHash: "a".repeat(64),
    releases: [
      { itemID: "guide", version: 1, manifestHash: "1".repeat(64) },
      { itemID: "keep", version: 5, manifestHash: "5".repeat(64) },
    ],
    updatedBy: "account-a",
    updatedAt: 1,
  }
  const versions = [3, 2].map((version) => ({
    ...item,
    version,
    manifestHash: String(version).repeat(64),
    publishedAt: version,
    fileCount: 0,
    totalBytes: 0,
  }))
  let nextSequence = 0
  let change: { itemID: string; reference?: typeof selected.releases[number] } | undefined
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const url = new URL(request.path, "https://a.example")
    if (request.method === "POST" && url.pathname.includes("/selection-updates")) {
      writes.push(request)
      if (url.pathname.endsWith("/pages")) { change = JSON.parse(request.body!).changes[0]; nextSequence=1 }
      if (url.pathname.endsWith("/commit")) selected = {...selected,revision:3,releases:[...selected.releases.filter((reference) => reference.itemID !== change!.itemID),...(change?.reference ? [change.reference] : [])]}
    }
    const summary = {revision:selected.revision,manifestHash:selected.manifestHash,updatedBy:selected.updatedBy,updatedAt:selected.updatedAt,releaseCount:selected.releases.length}
    const body =
      url.pathname === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : url.pathname === "/org/v1/projects/project-one"
          ? project
          : url.pathname.endsWith("/knowledge/applied/references")
            ? {selection:summary,items:selected.releases.filter((reference) => JSON.parse(request.body!).itemIDs.includes(reference.itemID))}
            : url.pathname.includes("/selection-updates")
              ? url.pathname.endsWith("/commit") ? summary : {updateID:"update-guide",target:{kind:"member",projectID:"project-one"},baseRevision:2,nextSequence,state:"draft"}
            : url.pathname === "/org/v1/knowledge"
              ? { items: [item] }
              : url.pathname.endsWith("/versions")
                ? { items: versions }
                : { items: [] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(
      new URL("/organization/org-a/account-a/deployment-a/projects/project-one/knowledge", server.url).href,
    )
    await page.getByRole("button", { name: /Field guidelines/ }).click()
    await page.getByRole("button", { name: "Version 2", exact: true }).click()
    expect(writes).toHaveLength(0)
    await page.getByRole("button", { name: "Update my applied version", exact: true }).click()
    await page.getByText("Applied version 2", { exact: true }).waitFor()
    expect(writes).toHaveLength(3)
    expect(JSON.parse(writes[0]!.body!)).toMatchObject({target:{kind:"member",projectID:"project-one"},expectedRevision:2})
    expect(JSON.parse(writes[1]!.body!)).toEqual({sequence:0,changes:[{itemID:"guide",reference:{itemID:"guide",version:2,manifestHash:"2".repeat(64)}}]})
    expect(JSON.parse(writes[2]!.body!)).toEqual({expectedSequence:1})
    expect(selected.releases).toContainEqual({itemID:"keep",version:5,manifestHash:"5".repeat(64)})
    expect(await page.getByRole("button", { name: "Publish new version", exact: true }).count()).toBe(0)
  } finally {
    await page.close()
  }
}, 30_000)

test("project artifacts remain readable without exposing an unavailable source conversation", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const requests: Desktop.Request[] = []
  const project = {
    projectID: "project-one",
    orgID: "org-a",
    name: "Field notes",
    description: "Shared research",
    state: "active",
    revision: 1,
    createdAt: 0,
    permissions: { read: true, manage: false, execute: false },
    role: "reader",
  }
  const item = {
    artifactID: "report",
    orgID: "org-a",
    projectID: "project-one",
    title: "Published report",
    version: 2,
    revision: 2,
    authorID: "account-b",
    publishedAt: 2,
    manifestHash: "b".repeat(64),
    fileCount: 0,
    totalBytes: 0,
    sourceAvailable: false,
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    requests.push(request)
    const url = new URL(request.path, "https://a.example")
    const body =
      url.pathname === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : url.pathname === "/org/v1/projects/project-one"
          ? project
          : url.pathname.endsWith("/reference")
            ? { artifactID: "report", version: 2, manifestHash: item.manifestHash, projectID: "project-one", files: [] }
            : { items: [item] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(
      new URL("/organization/org-a/account-a/deployment-a/projects/project-one/artifacts", server.url).href,
    )
    await page.getByRole("button", { name: /Published report/ }).click()
    await page.getByText("The source conversation is not available to your account.", { exact: true }).waitFor()
    await page.getByLabel("Versioned reference", { exact: true }).waitFor()
    expect(await page.getByRole("button", { name: "Open source conversation", exact: true }).count()).toBe(0)
    expect(requests.some((request) => request.path.startsWith("/org/v1/sessions/"))).toBe(false)
  } finally {
    await page.close()
  }
}, 30_000)

test("a maintainer adds a project member from public candidates with the observed project revision", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const writes: Desktop.Request[] = []
  const paths: string[] = []
  const alice = { accountID: "alice", displayName: "Alice", loginName: "alice", state: "active", role: "reader" }
  const bob = { accountID: "bob", displayName: "Bob", loginName: "bob", state: "active" }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    paths.push(request.path)
    if (request.method === "PUT") writes.push(request)
    const url = new URL(request.path, "https://a.example")
    const revision = writes.length ? 8 : 7
    const project = {
      projectID: "project-one",
      orgID: "org-a",
      name: "Field notes",
      description: "Shared research",
      state: "active",
      revision,
      createdAt: 0,
      permissions: { read: true, manage: true, execute: true },
      role: "maintainer",
    }
    const body =
      url.pathname === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : request.method === "PUT"
          ? { success: true }
          : url.pathname === "/org/v1/projects/project-one"
            ? project
            : url.pathname.endsWith("/member-candidates")
              ? { projectRevision: revision, items: [bob] }
              : { projectRevision: revision, items: writes.length ? [alice, { ...bob, role: "reader" }] : [alice] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a/projects/project-one/members", server.url).href)
    await page.getByRole("button", { name: "Add project member", exact: true }).click()
    await page
      .getByRole("listitem")
      .filter({ hasText: "Bob" })
      .getByRole("button", { name: "Add project member", exact: true })
      .click()
    await page.getByRole("button", { name: /^Role: Bob:/ }).waitFor()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("/org/v1/projects/project-one/members/bob")
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 7, role: "reader" })
    expect(paths.some((path) => path.startsWith("/org/v1/accounts"))).toBe(false)
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
