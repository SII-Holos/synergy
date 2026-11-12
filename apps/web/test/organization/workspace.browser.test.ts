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

test.each(["PERMISSION_DENIED", "permission_denied", "SERVICE_UNAVAILABLE"] as const)(
  "project recovery (%s) distinguishes access loss from a disconnected editor",
  async (code) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const owner = { ...entries[0]!, account: { ...entries[0]!.account, role: "owner" as const } }
    let denied = false
    let restored = false
    const project = {
      projectID: "guarded-project",
      orgID: "org-a",
      name: "Confidential study",
      description: "Private project instructions",
      state: "active",
      revision: 1,
      createdAt: 0,
      permissions: { read: true, manage: true, execute: true },
      role: "maintainer",
    }
    await page.exposeFunction("hostList", () => ({ ok: true, value: [owner] }))
    await page.exposeFunction("hostCancel", () => ({ ok: true }))
    await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
      if (request.path === "/org/v1/projects/guarded-project" && request.method !== "GET") denied = true
      if (request.path === "/org/v1/projects/guarded-project" && denied && !restored)
        return code === "permission_denied"
          ? { ok: false, error: { code } }
          : {
              ok: true,
              value: {
                status: code === "SERVICE_UNAVAILABLE" ? 503 : 403,
                body: JSON.stringify({ code, message: "Request unavailable", retryable: false }),
              },
            }
      const body =
        request.path === "/org/v1/organization"
          ? { orgID: "org-a", name: "Field team", revision: 1 }
          : request.path === "/org/v1/projects/guarded-project"
            ? restored
              ? {
                  ...project,
                  name: "Current project",
                  description: "Current readable instructions",
                  permissions:
                    code === "SERVICE_UNAVAILABLE"
                      ? project.permissions
                      : { read: true, manage: false, execute: false },
                  role: code === "SERVICE_UNAVAILABLE" ? "maintainer" : "reader",
                }
              : project
            : { items: [project] }
      return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
    })
    try {
      await page.goto(server.url)
      await page.getByRole("button", { name: "Current space" }).click()
      await page.getByRole("menuitem", { name: /a.example.*Member A/ }).click()
      await page.getByRole("button", { name: /Confidential study/ }).click()
      await page.getByRole("button", { name: "Edit project", exact: true }).click()
      await page.getByLabel("Description", { exact: true }).fill("Private unsaved changes")
      await page.getByRole("button", { name: "Save changes", exact: true }).click()
      await page.getByRole("alert").waitFor()
      const retained = code === "SERVICE_UNAVAILABLE"
      expect(await page.getByRole("heading", { name: "Confidential study", exact: true }).count()).toBe(
        retained ? 1 : 0,
      )
      expect(await page.getByLabel("Description", { exact: true }).count()).toBe(retained ? 1 : 0)
      if (retained)
        expect(await page.getByLabel("Description", { exact: true }).inputValue()).toBe("Private unsaved changes")
      expect(await page.getByRole("button", { name: "Archive project", exact: true }).count()).toBe(0)
      expect(await page.getByRole("navigation", { name: "Project navigation" }).count()).toBe(retained ? 1 : 0)
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await page.getByRole("alert").waitFor()
      expect(await page.getByRole("heading", { name: "Confidential study", exact: true }).count()).toBe(
        retained ? 1 : 0,
      )
      restored = true
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await page.getByRole("heading", { name: "Current project", exact: true }).waitFor()
      expect(await page.getByRole("button", { name: "Edit project", exact: true }).count()).toBe(0)
      if (retained)
        expect(await page.getByLabel("Description", { exact: true }).inputValue()).toBe("Private unsaved changes")
      else {
        expect(await page.getByLabel("Description", { exact: true }).count()).toBe(0)
        expect(await page.getByText("Current readable instructions", { exact: true }).count()).toBe(1)
      }
      if (process.env.SYNERGY_UI_SCREENSHOT_DIR && code === "PERMISSION_DENIED") {
        await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, "project-access-restored.png") })
      }
    } finally {
      await page.close()
    }
  },
  30_000,
)

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
  let change: { itemID: string; reference?: (typeof selected.releases)[number] } | undefined
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const url = new URL(request.path, "https://a.example")
    if (request.method === "POST" && url.pathname.includes("/selection-updates")) {
      writes.push(request)
      if (url.pathname.endsWith("/pages")) {
        change = JSON.parse(request.body!).changes[0]
        nextSequence = 1
      }
      if (url.pathname.endsWith("/commit"))
        selected = {
          ...selected,
          revision: 3,
          releases: [
            ...selected.releases.filter((reference) => reference.itemID !== change!.itemID),
            ...(change?.reference ? [change.reference] : []),
          ],
        }
    }
    const summary = {
      revision: selected.revision,
      manifestHash: selected.manifestHash,
      updatedBy: selected.updatedBy,
      updatedAt: selected.updatedAt,
      releaseCount: selected.releases.length,
    }
    const body =
      url.pathname === "/org/v1/organization"
        ? { orgID: "org-a", name: "Field team", revision: 1 }
        : url.pathname === "/org/v1/projects/project-one"
          ? project
          : url.pathname.endsWith("/knowledge/applied/references")
            ? {
                selection: summary,
                items: selected.releases.filter((reference) =>
                  JSON.parse(request.body!).itemIDs.includes(reference.itemID),
                ),
              }
            : url.pathname.includes("/selection-updates")
              ? url.pathname.endsWith("/commit")
                ? summary
                : {
                    updateID: "update-guide",
                    target: { kind: "member", projectID: "project-one" },
                    baseRevision: 2,
                    nextSequence,
                    state: "draft",
                  }
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
    expect(JSON.parse(writes[0]!.body!)).toMatchObject({
      target: { kind: "member", projectID: "project-one" },
      expectedRevision: 2,
    })
    expect(JSON.parse(writes[1]!.body!)).toEqual({
      sequence: 0,
      changes: [{ itemID: "guide", reference: { itemID: "guide", version: 2, manifestHash: "2".repeat(64) } }],
    })
    expect(JSON.parse(writes[2]!.body!)).toEqual({ expectedSequence: 1 })
    expect(selected.releases).toContainEqual({ itemID: "keep", version: 5, manifestHash: "5".repeat(64) })
    expect(await page.getByRole("button", { name: "Publish new version", exact: true }).count()).toBe(1)
    expect(await page.getByRole("button", { name: "Withdraw publication", exact: true }).count()).toBe(1)
  } finally {
    await page.close()
  }
}, 30_000)

for (const width of [375, 1100])
  for (const access of ["collaborator", "reader", "archived"] as const)
    test(`project knowledge publication follows current execution permission for ${access} at ${width}px`, async () => {
      const page = await browser.newPage({
        viewport: { width, height: width === 375 ? 667 : 760 },
        colorScheme: width === 375 ? "light" : "dark",
      })
      const canPublish = access === "collaborator"
      const item = {
        itemID: "policy-guide",
        orgID: "org-a",
        scope: { kind: "project", projectID: "project-policy" },
        kind: "skill",
        title: "Project review skill",
        latestVersion: 1,
        revision: 1,
        state: "published",
        createdAt: 1,
      }
      await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
      await page.exposeFunction("hostCancel", () => ({ ok: true }))
      await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
        const url = new URL(request.path, "https://a.example")
        const body =
          url.pathname === "/org/v1/organization"
            ? { orgID: "org-a", name: "Field team", revision: 1 }
            : url.pathname === "/org/v1/projects/project-policy"
              ? {
                  projectID: "project-policy",
                  orgID: "org-a",
                  name: "Policy project",
                  description: "Shared methods",
                  state: access === "archived" ? "archived" : "active",
                  role: access === "archived" ? "maintainer" : access,
                  revision: 1,
                  createdAt: 1,
                  permissions: { read: true, manage: access === "archived", execute: canPublish },
                }
              : url.pathname === "/org/v1/knowledge"
                ? { items: [item] }
                : url.pathname.endsWith("/knowledge/applied/references")
                  ? {
                      selection: { revision: 0, manifestHash: "0".repeat(64), releaseCount: 0 },
                      items: [],
                    }
                  : url.pathname.endsWith("/versions")
                    ? {
                        items: [
                          {
                            ...item,
                            version: 1,
                            manifestHash: "1".repeat(64),
                            authorID: "author",
                            publishedAt: 1,
                            fileCount: 0,
                            totalBytes: 0,
                          },
                        ],
                      }
                    : { items: [] }
        return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
      })
      try {
        await page.goto(
          new URL("/organization/org-a/account-a/deployment-a/projects/project-policy/knowledge", server.url).href,
        )
        await page.getByRole("button", { name: /Project review skill/ }).click()
        await page.getByRole("button", { name: "Version 1", exact: true }).waitFor()
        expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(canPublish ? 1 : 0)
        expect(await page.getByRole("button", { name: "Publish new version", exact: true }).count()).toBe(
          canPublish ? 1 : 0,
        )
        expect(await page.getByRole("button", { name: "Withdraw publication", exact: true }).count()).toBe(
          canPublish ? 1 : 0,
        )
        if (canPublish) {
          await page.getByRole("button", { name: "Publish", exact: true }).click()
          await page.getByLabel("Title", { exact: true }).waitFor()
          expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(1)
          await page.getByRole("button", { name: "Cancel", exact: true }).click()
          await page.getByRole("button", { name: /Project review skill/ }).click()
        }
        const version = page.getByRole("button", { name: "Version 1", exact: true })
        await version.click()
        const visibleAction = canPublish
          ? page.getByRole("button", { name: "Publish new version", exact: true })
          : version
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await visibleAction.scrollIntoViewIfNeeded()
        await visibleAction.hover()
        if (width === 375) await page.mouse.wheel(0, 64)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        if (process.env.SYNERGY_UI_SCREENSHOT_DIR) {
          await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
          await page.screenshot({
            path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, `knowledge-${access}-${width}.png`),
          })
        }
        const bounds = await visibleAction.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 375 ? 667 : 760)
        expect(
          await visibleAction.evaluate((button) => {
            const bounds = button.getBoundingClientRect()
            const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            return hit === button || (!!hit && button.contains(hit))
          }),
        ).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      } finally {
        await page.close()
      }
    }, 30_000)

for (const destination of ["members", "resources"] as const)
  test(`a member's unavailable ${destination} deep link offers an explicit route back to projects`, async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
    const requests: string[] = []
    await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
    await page.exposeFunction("hostCancel", () => ({ ok: true }))
    await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
      requests.push(request.path)
      return {
        ok: true,
        value: {
          status: 200,
          body: JSON.stringify(
            request.path === "/org/v1/organization"
              ? { orgID: "org-a", name: "Field team", revision: 1 }
              : { items: [] },
          ),
        },
      }
    })
    try {
      await page.goto(new URL(`/organization/org-a/account-a/deployment-a/${destination}`, server.url).href)
      await page.getByRole("alert").waitFor({ timeout: 5000 })
      expect(await page.getByRole("alert").innerText()).toContain("Your access has changed")
      const back = page.getByRole("button", { name: "All projects", exact: true })
      await back.focus()
      await page.keyboard.press("Enter")
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor()
      expect(requests.some((value) => /^\/org\/v1\/(accounts|resources)(?:\?|$)/.test(value))).toBe(false)
      expect(page.url()).toEndWith("/organization/org-a/account-a/deployment-a")
    } finally {
      await page.close()
    }
  }, 15_000)

test("a project reader's members deep link explains the unavailable action without hiding its readable project", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: "dark" })
  const paths: string[] = []
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    paths.push(request.path)
    return {
      ok: true,
      value: {
        status: 200,
        body: JSON.stringify(
          request.path === "/org/v1/organization"
            ? { orgID: "org-a", name: "Field team", revision: 1 }
            : {
                projectID: "project-read",
                orgID: "org-a",
                name: "Readable project",
                description: "Project history remains available",
                state: "active",
                role: "reader",
                revision: 1,
                createdAt: 1,
                permissions: { read: true, manage: false, execute: false },
              },
        ),
      },
    }
  })
  try {
    await page.goto(
      new URL("/organization/org-a/account-a/deployment-a/projects/project-read/members", server.url).href,
    )
    await page.getByRole("heading", { name: "Readable project", exact: true }).waitFor()
    await page.getByRole("alert").waitFor({ timeout: 5000 })
    expect(await page.getByText("Project history remains available", { exact: true }).count()).toBe(1)
    expect(paths.some((value) => value.includes("/members"))).toBe(false)
    await page.getByRole("button", { name: "Overview", exact: true }).click()
    expect(page.url()).toEndWith("/projects/project-read")
    expect(await page.getByRole("alert").count()).toBe(0)
  } finally {
    await page.close()
  }
}, 15_000)

test("a knowledge withdrawal retains the exact revision observed when its confirmation opened", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const writes: Desktop.Request[] = []
  let reads = 0
  let references = 0
  const item = {
    itemID: "policy",
    orgID: "org-a",
    scope: { kind: "project", projectID: "project-one" },
    kind: "material",
    title: "Original policy",
    revision: 1,
    latestVersion: 1,
    state: "published",
    createdAt: 1,
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entries[0]!] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const url = new URL(request.path, "https://a.example")
    let body: unknown = { items: [] }
    if (url.pathname === "/org/v1/organization") body = { orgID: "org-a", name: "Field team", revision: 1 }
    else if (url.pathname === "/org/v1/projects/project-one")
      body = {
        projectID: "project-one",
        orgID: "org-a",
        name: "Policy project",
        description: "Shared methods",
        state: "active",
        role: "maintainer",
        revision: 1,
        createdAt: 1,
        permissions: { read: true, manage: true, execute: true },
      }
    else if (url.pathname === "/org/v1/knowledge") {
      reads++
      if (reads === 2) {
        entered.resolve()
        await release.promise
      }
      body = { items: [{ ...item, ...(reads >= 2 ? { title: "Updated policy", revision: 2 } : {}) }] }
    } else if (url.pathname.endsWith("/knowledge/applied/references")) {
      if (++references === 1)
        return {
          ok: true,
          value: { status: 503, body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "Try again" }) },
        }
      body = { selection: { revision: 0, manifestHash: "0".repeat(64), releaseCount: 0 }, items: [] }
    } else if (url.pathname.endsWith("/versions"))
      body = {
        items: [
          {
            ...item,
            version: 1,
            manifestHash: "1".repeat(64),
            authorID: "author",
            publishedAt: 1,
            fileCount: 0,
            totalBytes: 0,
          },
        ],
      }
    else if (request.method === "DELETE" && url.pathname === "/org/v1/knowledge/policy") {
      writes.push(request)
      body = { ...item, revision: 3, state: "withdrawn" }
    }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(
      new URL("/organization/org-a/account-a/deployment-a/projects/project-one/knowledge", server.url).href,
    )
    await page.getByRole("button", { name: /Original policy/ }).click()
    await page.getByRole("button", { name: "Withdraw publication", exact: true }).waitFor()
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await entered.promise
    await page.getByRole("button", { name: "Withdraw publication", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Withdraw publication", exact: true }).waitFor()
    release.resolve()
    await page.getByRole("button", { name: /Updated policy/ }).waitFor()
    await dialog.getByRole("button", { name: "Withdraw publication", exact: true }).click()
    await dialog.waitFor({ state: "detached", timeout: 5000 })
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: 1 })
  } finally {
    release.resolve()
    await page.close()
  }
}, 20_000)

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
