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

test("connecting an organization stays compact and offers a direct return while personal is offline", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  try {
    await page.goto(server.url)
    await page.getByRole("button", { name: "Current space" }).click()
    await page.getByRole("menuitem", { name: "Connect organization" }).click()
    await page.getByRole("heading", { name: "Connect organization", exact: true }).first().waitFor()
    expect(await page.getByRole("heading", { name: "Connect organization", exact: true }).count()).toBe(1)
    const panel = await page.locator(".organization-connect-panel").boundingBox()
    expect(panel?.width).toBeGreaterThanOrEqual(380)
    expect(panel?.width).toBeLessThanOrEqual(480)
    expect(Math.abs(panel!.x + panel!.width / 2 - 720)).toBeLessThanOrEqual(24)
    expect(
      (await page.getByRole("button", { name: "Connect organization", exact: true }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(40)
    await page.getByRole("button", { name: "Back to personal space" }).click()
    await page.getByRole("heading", { name: "Can’t reach the server" }).waitFor()
  } finally {
    await page.close()
  }
}, 30_000)

test("the actual app switches organizations while personal is offline and rejects a late project response", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cancelled: string[] = []
  const errors: string[] = []
  const requests: Array<{ connection: string; path: string }> = []
  let held = true
  page.on("pageerror", (error) => errors.push(error.message))
  await page.exposeFunction("hostList", () => ({ ok: true, value: entries }))
  await page.exposeFunction("hostCancel", (value: { requestID: string }) => {
    cancelled.push(value.requestID)
    return { ok: true }
  })
  await page.exposeFunction("hostConnect", () => ({ ok: true, value: entries[0] }))
  await page.exposeFunction("hostSignOut", () => ({ ok: true, value: { ...entries[1], state: "signed_out" } }))
  await page.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const id = request.connectionID[0]
    requests.push({ connection: id, path: request.path })
    if (id === "a" && request.path.startsWith("/org/v1/projects") && held) {
      started.resolve()
      await release.promise
    }
    const project = {
      projectID: `project-${id}`,
      orgID: `org-${id}`,
      name: `Project ${id.toUpperCase()}`,
      description: `Description ${id}`,
      state: "active",
      revision: 1,
      createdAt: 0,
      permissions: { read: true, manage: false, execute: false },
      role: "reader",
    }
    const body =
      request.path === "/org/v1/organization"
        ? { orgID: `org-${id}`, name: `Team ${id.toUpperCase()}`, revision: 1 }
        : request.path.startsWith(`/org/v1/projects/project-${id}`)
          ? project
          : { items: [project] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    page.setDefaultTimeout(10_000)
    await page.goto(server.url)
    const switcher = page.getByRole("button", { name: "Current space" })
    await switcher.click()
    await page.getByRole("menuitem", { name: /a.example.*Member A/ }).click()
    await page
      .getByRole("status")
      .waitFor()
      .catch(async (error: unknown) => {
        console.log(JSON.stringify({ errors, url: page.url(), body: await page.locator("body").innerText() }))
        throw error
      })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        started.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Project request did not reach its transport")), 5000)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
    await switcher.click()
    await page.getByRole("menuitem", { name: /b.example.*Member B/ }).click()
    await page.getByRole("button", { name: /Project B/ }).waitFor()
    held = false
    release.resolve()
    expect(cancelled.length).toBeGreaterThan(0)
    expect(await page.getByRole("button", { name: /Project A/ }).count()).toBe(0)
    await page.getByRole("button", { name: /Project B/ }).click()
    await page.getByRole("heading", { name: "Project B" }).waitFor()
    expect(page.url()).toContain("/organization/org-b/account-b/deployment-b/projects/project-b")
    await page.reload()
    await page.getByRole("heading", { name: "Project B" }).waitFor()
    await page.setViewportSize({ width: 375, height: 740 })
    await switcher.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("menu").waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.matches(".space-switcher-trigger"))
    const screenshots = path.resolve(source, "../../../.artifacts/testing/organization-space")
    await fs.mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: path.join(screenshots, "project-narrow.png") })
    await switcher.click()
    await page.getByRole("menuitem", { name: "Personal space", exact: true }).click()
    await page.getByRole("heading", { name: "Can’t reach the server" }).waitFor()
    expect(errors).toEqual([])
  } catch (error) {
    console.log(JSON.stringify({ errors, requests, url: page.url(), body: await page.locator("body").innerText() }))
    throw error
  } finally {
    release.resolve()
    await page.close()
  }
}, 45_000)

test("Chinese native connection and pending logout remain operable in the narrow dark app", async () => {
  const page = await browser.newPage({ locale: "zh-CN", colorScheme: "dark", viewport: { width: 375, height: 740 } })
  let current: Desktop.Connection | undefined
  let signOuts = 0
  const starts: Desktop.Start[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.exposeFunction("hostList", () => ({ ok: true, value: current ? [current] : [] }))
  await page.exposeFunction("hostCancel", () => ({ ok: true }))
  await page.exposeFunction("hostConnect", (input: Desktop.Start) => {
    starts.push(input)
    current = entries[1]
    return { ok: true, value: current }
  })
  await page.exposeFunction("hostSignOut", () => {
    current = { ...entries[1]!, state: ++signOuts === 1 ? "sign_out_pending" : "signed_out" }
    return signOuts === 1 ? { ok: false, error: { code: "unavailable" } } : { ok: true, value: current }
  })
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => ({
    ok: true,
    value: {
      status: 200,
      body: JSON.stringify(
        request.path === "/org/v1/organization"
          ? { orgID: "org-b", name: "团队 B", revision: 1 }
          : {
              items: [
                {
                  projectID: "project-b",
                  orgID: "org-b",
                  name: "项目 B",
                  description: "可查看的团队项目",
                  state: "active",
                  revision: 1,
                  createdAt: 0,
                  permissions: { read: true, manage: false, execute: false },
                  role: "reader",
                },
              ],
            },
      ),
    },
  }))
  try {
    page.setDefaultTimeout(10_000)
    await page.goto(server.url)
    await page.getByRole("button", { name: "当前空间" }).click()
    await page.getByRole("menuitem", { name: "连接组织" }).click()
    await page.getByLabel("组织地址").fill("https://b.example")
    await page.locator(".organization-connect-advanced summary").click()
    await page.getByLabel("客户端 ID").fill("desktop")
    await page.getByRole("button", { name: "连接组织", exact: true }).click()
    await page.getByRole("button", { name: /项目 B/ }).waitFor()
    await page.getByRole("button", { name: "退出登录", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    expect(signOuts).toBe(0)
    await page.getByRole("button", { name: "退出登录", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "退出登录", exact: true }).click()
    await page.getByRole("heading", { name: "退出尚未完成" }).waitFor()
    expect(await page.getByRole("button", { name: /项目 B/ }).count()).toBe(0)
    await page.reload()
    await page.getByRole("button", { name: "完成退出" }).click()
    await page.getByRole("heading", { name: "已退出登录" }).waitFor()
    await page.getByRole("button", { name: "恢复组织连接" }).click()
    await page.getByRole("button", { name: /项目 B/ }).waitFor()
    expect(starts[1]?.target.expected).toEqual({
      orgID: "org-b",
      accountID: "account-b",
      deploymentIncarnation: "deployment-b",
    })
    expect(signOuts).toBe(2)
    const actions = await page.locator(".organization-space-header button, .organization-space-content button").all()
    for (const action of actions) expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const screenshots = path.resolve(source, "../../../.artifacts/testing/organization-space")
    await fs.mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: path.join(screenshots, "projects-dark-zh.png") })
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
}, 30_000)
