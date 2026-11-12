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
    import { Show } from "solid-js"
    import { SpaceProvider, useSpace } from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import { OrganizationSessionResources } from ${JSON.stringify(`/@fs/${source}/organization/session-resources.tsx`)}
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    const platform = { platform: "web", openLink() {}, organization: { protocolVersion: 2,
      list: () => window.hostList(), request: value => window.hostRequest(value), cancel: value => window.hostCancel(value),
      connect: value => window.hostConnect(value), signOut: value => window.hostSignOut(value),
    }, fetch: async () => Response.json({ healthy: false }) }
    function Resources() { const space = useSpace(); return <Show when={space.current()?.identity.kind === "organization"}><OrganizationSessionResources projectID="project-one" sessionID="session-one" canExecute={true} /></Show> }
    render(() => <PlatformProvider value={platform}><AppBaseProviders>{new URLSearchParams(location.search).get("fixture") === "resources" ? <SpaceProvider><Resources /></SpaceProvider> : <AppInterface />}</AppBaseProviders></PlatformProvider>, document.getElementById("root"))
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
    if (url.pathname === "/org/v1/organization") return json({ orgID: "org-a", name: "Field team", revision: 1 })
    if (url.pathname === "/org/v1/projects/project-one") return json(project)
    return handle(request, url)
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

for (const width of [375, 1100])
  test(`a cancelled resource editor cannot let an accepted old save close its replacement at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 667 : 760 } })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>()
    const writes: Desktop.Request[] = []
    try {
      await open(page, "resources", async (request) => {
        if (request.method === "POST") {
          writes.push(request)
          if (writes.length === 1) {
            entered.resolve()
            await release.promise
            delivered.resolve()
          }
          return json({ ...resource, name: JSON.parse(request.body!).name })
        }
        return json({ items: [resource] })
      })
      await page.getByRole("button", { name: "Add resource", exact: true }).click()
      await page.getByLabel("Resource name").fill("First accepted resource")
      await page.getByLabel("Endpoint", { exact: true }).fill("https://models.example/v1")
      await page.getByLabel("Model ID").fill("first-model")
      await page.getByRole("button", { name: "Save resource", exact: true }).click()
      await entered.promise
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Add resource", exact: true }).click()
      await page.getByLabel("Resource name").fill("Replacement draft")
      await page.getByLabel("API key", { exact: true }).fill("replacement-private-key")
      release.resolve()
      await delivered.promise
      await settled(page)
      expect(await page.getByLabel("Resource name").count()).toBe(1)
      expect(await page.getByLabel("Resource name").inputValue()).toBe("Replacement draft")
      expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("replacement-private-key")
      expect(writes).toHaveLength(1)
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("replacement-private-key")
      await page.getByRole("button", { name: "Save resource", exact: true }).scrollIntoViewIfNeeded()
      const bounds = await page.getByRole("button", { name: "Save resource", exact: true }).boundingBox()
      expect(bounds!.height).toBeGreaterThanOrEqual(40)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 375 ? 667 : 760)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await screenshot(page, `resource-replacement-${width}.png`)
    } finally {
      release.resolve()
      await page.close()
    }
  }, 30_000)

for (const kind of ["resources", "knowledge", "members", "artifacts"] as const)
  for (const code of ["PERMISSION_DENIED", "SERVICE_UNAVAILABLE"] as const)
    test(`${kind} recovery clears confirmed private access loss and retains transport drafts (${code})`, async () => {
      const width = kind === "resources" || kind === "members" ? 375 : 1100
      const page = await browser.newPage({ viewport: { width, height: width === 375 ? 667 : 760 } })
      let recovered = false
      const name = {
        resources: resource.name,
        knowledge: knowledge.title,
        members: member.displayName,
        artifacts: artifact.title,
      }[kind]
      const freshName = `Current ${kind}`
      const token = "f".repeat(64)
      const listPath = {
        resources: "/org/v1/resources",
        knowledge: "/org/v1/knowledge",
        members: "/org/v1/accounts",
        artifacts: "/org/v1/projects/project-one/artifacts",
      }[kind]
      try {
        await open(page, kind === "artifacts" ? "projects/project-one/artifacts" : kind, (request, url) => {
          if (url.pathname === listPath) {
            if (url.searchParams.has("cursor") && !recovered)
              return json({ code, message: code }, code === "PERMISSION_DENIED" ? 403 : 503)
            const item =
              kind === "resources"
                ? { ...resource, name: recovered ? freshName : name }
                : kind === "knowledge"
                  ? { ...knowledge, title: recovered ? freshName : name }
                  : kind === "members"
                    ? { ...member, displayName: recovered ? freshName : name }
                    : { ...artifact, title: recovered ? freshName : name }
            return json({ items: [item], ...(!recovered ? { cursor: "second-page" } : {}) })
          }
          if (url.pathname === "/org/v1/invites" && request.method === "POST")
            return json({ token, expiresAt: Date.now() + 3600000 })
          if (url.pathname === "/org/v1/artifacts/report/versions") return json({ items: [artifact] })
          if (url.pathname.endsWith("/reference")) return json({ ...artifact, files: [] })
          throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
        })
        await page.getByText(name, { exact: true }).first().waitFor()
        if (kind === "resources") {
          await page.getByRole("button", { name: "Add resource", exact: true }).click()
          await page.getByLabel("Resource name").fill("Unsent resource")
          await page.getByLabel("API key", { exact: true }).fill("unsent-private-key")
        } else if (kind === "knowledge") {
          await page.getByRole("button", { name: "Publish", exact: true }).click()
          await page.getByLabel("Title", { exact: true }).fill("Unsent knowledge")
        } else if (kind === "members") {
          await page.getByRole("button", { name: "Invite member", exact: true }).click()
          await page.locator(".organization-editor").getByRole("button", { name: "Invite member", exact: true }).click()
          await page.getByLabel("Invitation link", { exact: true }).waitFor()
        } else {
          await page.getByRole("button", { name: new RegExp(name) }).click()
          await page.getByLabel("Versioned reference", { exact: true }).waitFor()
        }
        await page.getByRole("button", { name: "Load more", exact: true }).click()
        await page.getByRole("alert").waitFor()
        const hard = code === "PERMISSION_DENIED"
        expect(await page.getByText(name, { exact: true }).count()).toBe(hard ? 0 : 1)
        if (kind === "resources") {
          expect(await page.getByLabel("Resource name").count()).toBe(hard ? 0 : 1)
          expect(await page.getByRole("button", { name: "Add resource", exact: true }).count()).toBe(0)
          if (!hard) expect(await page.getByLabel("Resource name").inputValue()).toBe("Unsent resource")
        } else if (kind === "knowledge") {
          expect(await page.getByLabel("Title", { exact: true }).count()).toBe(hard ? 0 : 1)
          if (!hard) expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Unsent knowledge")
        } else if (kind === "members") {
          expect(await page.getByLabel("Invitation link", { exact: true }).count()).toBe(hard ? 0 : 1)
          if (!hard) expect(await page.getByLabel("Invitation link", { exact: true }).inputValue()).toContain(token)
        } else expect(await page.getByLabel("Versioned reference", { exact: true }).count()).toBe(hard ? 0 : 1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await screenshot(page, `${kind}-${hard ? "access-lost" : "disconnected"}-${width}.png`)
        recovered = true
        await page.getByRole("button", { name: "Retry", exact: true }).click()
        await page.getByText(freshName, { exact: true }).first().waitFor()
        if (!hard && kind === "resources")
          expect(await page.getByLabel("Resource name").inputValue()).toBe("Unsent resource")
        if (!hard && kind === "knowledge")
          expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Unsent knowledge")
      } finally {
        await page.close()
      }
    }, 30_000)

test("an invitation accepted before access loss cannot overwrite a later recovered invitation", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>()
  let issued = 0,
    recovered = false
  const oldToken = "a".repeat(64),
    freshToken = "e".repeat(64)
  try {
    await open(page, "members", async (request, url) => {
      if (url.pathname === "/org/v1/invites") {
        issued++
        if (issued === 1) {
          entered.resolve()
          await release.promise
          delivered.resolve()
          return json({ token: oldToken, expiresAt: Date.now() + 3600000 })
        }
        return json({ token: freshToken, expiresAt: Date.now() + 3600000 })
      }
      if (url.pathname === "/org/v1/accounts") {
        if (url.searchParams.has("cursor") && !recovered)
          return json({ code: "PERMISSION_DENIED", message: "Access removed" }, 403)
        return json({ items: [member], ...(!recovered ? { cursor: "second-page" } : {}) })
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    })
    await page.getByRole("button", { name: "Invite member", exact: true }).click()
    await page.locator(".organization-editor").getByRole("button", { name: "Invite member", exact: true }).click()
    await entered.promise
    await page.getByRole("button", { name: "Load more", exact: true }).click()
    await page.getByRole("alert").waitFor()
    expect(await page.getByText(member.displayName, { exact: true }).count()).toBe(0)
    recovered = true
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByText(member.displayName, { exact: true }).waitFor()
    await page.getByRole("button", { name: "Invite member", exact: true }).click()
    await page.locator(".organization-editor").getByRole("button", { name: "Invite member", exact: true }).click()
    await page.getByLabel("Invitation link", { exact: true }).waitFor()
    expect(await page.getByLabel("Invitation link", { exact: true }).inputValue()).toContain(freshToken)
    release.resolve()
    await delivered.promise
    await settled(page)
    expect(await page.getByLabel("Invitation link", { exact: true }).inputValue()).toContain(freshToken)
    expect(await page.getByLabel("Invitation link", { exact: true }).inputValue()).not.toContain(oldToken)
    expect(issued).toBe(2)
  } finally {
    release.resolve()
    await page.close()
  }
}, 30000)

for (const kind of ["knowledge", "artifacts"] as const)
  test(`${kind} file metadata denial invalidates its mounted catalog and detail`, async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
    const item = kind === "knowledge" ? knowledge : artifact
    const file = {
      fileID: "file-one",
      path: "private-guide.txt",
      bytes: 4,
      sha256: "a".repeat(64),
      mediaType: "text/plain",
    }
    try {
      await open(page, kind === "knowledge" ? "knowledge" : "projects/project-one/artifacts", (request, url) => {
        if (url.pathname === "/org/v1/knowledge" || url.pathname === "/org/v1/projects/project-one/artifacts")
          return json({ items: [item] })
        if (url.pathname.endsWith("/versions"))
          return json({
            items: [
              {
                ...item,
                version: 1,
                manifestHash: "a".repeat(64),
                authorID: "account-a",
                publishedAt: 1,
                fileCount: 1,
                totalBytes: 4,
              },
            ],
          })
        if (url.pathname.endsWith("/files") || url.pathname.endsWith("/reference")) {
          if (url.searchParams.has("cursor")) return json({ code: "PERMISSION_DENIED", message: "Access removed" }, 403)
          return json(
            kind === "knowledge"
              ? { items: [file], cursor: "second-page" }
              : { ...artifact, files: [file], cursor: "second-page" },
          )
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
      })
      await page.getByRole("button", { name: new RegExp(item.title) }).click()
      await page.getByText(file.path, { exact: true }).waitFor()
      await page
        .locator(".organization-publication-detail")
        .getByRole("button", { name: "Load more", exact: true })
        .click()
      await page.getByRole("alert").waitFor()
      expect(await page.getByText(item.title, { exact: true }).count()).toBe(0)
      expect(await page.getByText(file.path, { exact: true }).count()).toBe(0)
      expect(await page.locator(".organization-publication-detail").count()).toBe(0)
      expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 30000)

test("resource access denial closes the private access panel and its resource catalog", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await open(page, "resources", (request, url) => {
      if (url.pathname === "/org/v1/resources") return json({ items: [resource] })
      if (url.pathname === "/org/v1/accounts") return json({ items: [member] })
      if (url.pathname.includes("/grants")) return json({ code: "PERMISSION_DENIED", message: "Access removed" }, 403)
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    })
    await page.getByRole("button", { name: "Manage access", exact: true }).click()
    await page.getByRole("alert").waitFor()
    expect(await page.getByText(resource.name, { exact: true }).count()).toBe(0)
    expect(await page.locator(".organization-access-view").count()).toBe(0)
    expect(await page.getByRole("button", { name: "Add resource", exact: true }).count()).toBe(0)
  } finally {
    await page.close()
  }
}, 30000)

for (const infrastructure of [
  null,
  { workspace: null, environment: null },
  {
    workspace: { resourceID: "cloud-files", workspaceID: "workspace-one" },
    environment: { resourceID: "cloud-environment", environmentID: "environment-one" },
  },
])
  test(`editing a session model preserves its exact existing infrastructure (${infrastructure === null ? "first selection" : infrastructure.workspace ? "cloud" : "explicit null"})`, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    const writes: Desktop.Request[] = []
    const models = ["A", "B"].map((id) => ({
      resourceID: `model-${id}`,
      orgID: resource.orgID,
      scope: resource.scope,
      kind: resource.kind,
      state: resource.state,
      revision: resource.revision,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
      name: `Model ${id}`,
      definition: resource.configuration,
      permissions: { use: true },
    }))
    try {
      await open(page, "?fixture=resources", (request, url) => {
        if (url.pathname === "/org/v1/projects/project-one/resources") return json({ items: models })
        if (url.pathname === "/org/v1/sessions/session-one/resources") {
          if (request.method === "PUT") {
            writes.push(request)
            return json({ sessionID: "session-one", revision: 8, selection: JSON.parse(request.body!).selection })
          }
          return json({
            sessionID: "session-one",
            revision: 7,
            selection:
              infrastructure === null
                ? null
                : { modelResourceID: "model-A", connectionResourceIDs: [], infrastructure },
          })
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
      })
      await page
        .getByRole("button", {
          name: infrastructure === null ? "Model: Choose a project model" : "Model: Model A",
          exact: true,
        })
        .click()
      await page.getByRole("option", { name: "Model B", exact: true }).click()
      await page.getByRole("button", { name: "Save changes", exact: true }).click()
      await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0]!.body!)).toEqual({
        expectedRevision: 7,
        selection: {
          modelResourceID: "model-B",
          connectionResourceIDs: [],
          infrastructure: infrastructure ?? { workspace: null, environment: null },
        },
      })
    } finally {
      await page.close()
    }
  }, 30000)

for (const kind of ["resources", "members"] as const)
  for (const code of ["PERMISSION_DENIED", "SERVICE_UNAVAILABLE"] as const)
    test(`a held ${kind} catalog response retires only stale confirmations on ${code}`, async () => {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        delivered = Promise.withResolvers<void>()
      const writes: Desktop.Request[] = []
      let recovered = false
      const action = kind === "resources" ? "Disable" : "Remove member"
      const originalName = kind === "resources" ? resource.name : member.displayName
      const freshName = `Current ${kind} target`
      try {
        await open(page, kind, async (request, url) => {
          if (request.method === "PATCH") {
            writes.push(request)
            return json(
              kind === "resources"
                ? { ...resource, name: freshName, revision: 3, state: "disabled" }
                : { ...member, displayName: freshName, revision: 3, state: "removed" },
            )
          }
          if (url.pathname === (kind === "resources" ? "/org/v1/resources" : "/org/v1/accounts")) {
            if (url.searchParams.has("cursor") && !recovered) {
              entered.resolve()
              await release.promise
              delivered.resolve()
              return json({ code, message: code }, code === "PERMISSION_DENIED" ? 403 : 503)
            }
            return json({
              items: [
                kind === "resources"
                  ? { ...resource, name: recovered ? freshName : originalName, revision: recovered ? 2 : 1 }
                  : { ...member, displayName: recovered ? freshName : originalName, revision: recovered ? 2 : 1 },
              ],
              ...(!recovered ? { cursor: "second-page" } : {}),
            })
          }
          throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
        })
        await page.getByText(originalName, { exact: true }).waitFor()
        await page.getByRole("button", { name: "Load more", exact: true }).click()
        await entered.promise
        await page.getByRole("button", { name: action, exact: true }).click()
        const dialog = page.getByRole("dialog")
        await dialog.waitFor()
        const oldButton = await dialog.getByRole("button", { name: action, exact: true }).elementHandle()
        if (!oldButton) throw new Error("Original confirmation did not mount")
        release.resolve()
        await delivered.promise
        await settled(page)
        const hard = code === "PERMISSION_DENIED"
        expect(await page.getByRole("dialog").count()).toBe(hard ? 0 : 1)
        expect(writes).toHaveLength(0)
        if (!hard) {
          expect(await page.getByText(originalName, { exact: true }).count()).toBe(1)
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
          await oldButton.evaluate((button) => {
            if (!(button instanceof HTMLButtonElement)) throw new Error("Confirmation action is not a button")
            document.body.append(button)
            button.click()
            button.remove()
          })
          await settled(page)
          expect(writes).toHaveLength(0)
          return
        }
        recovered = true
        await page.getByRole("button", { name: "Retry", exact: true }).click()
        await page.getByText(freshName, { exact: true }).waitFor()
        await page.getByRole("button", { name: action, exact: true }).click()
        await page.getByRole("dialog").waitFor()
        await oldButton.evaluate((button) => {
          if (!(button instanceof HTMLButtonElement)) throw new Error("Confirmation action is not a button")
          document.body.append(button)
          button.click()
          button.remove()
        })
        await settled(page)
        expect(writes).toHaveLength(0)
        expect(await page.getByRole("dialog").count()).toBe(1)
        await page.getByRole("dialog").getByRole("button", { name: action, exact: true }).click()
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
        expect(writes).toHaveLength(1)
        expect(JSON.parse(writes[0]!.body!)).toEqual({
          expectedRevision: 2,
          state: kind === "resources" ? "disabled" : "removed",
        })
      } finally {
        release.resolve()
        await page.close()
      }
    }, 30000)
