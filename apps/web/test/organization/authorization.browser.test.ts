import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:https"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { chromium, type Browser } from "playwright"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { createBrowserFixture } from "../support/browser-fixture"
import { key, cert } from "../fixtures/organization-tls"

const source = path.resolve(import.meta.dir, "../../src")
const screenshots = path.resolve(source, "../../../.artifacts/testing/organization-authorization")
const resources = testResources()
let browser: Browser
let clientOrigin: string
let authority: { issuer: string; orgID: string; deploymentIncarnation: string }

beforeAll(async () => {
  await fs.mkdir(screenshots, { recursive: true })
  const isolated = await createIsolatedTestEnv()
  resources.defer("organization test Home", isolated.dispose)
  const directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-auth-"))
  resources.defer("organization fixture sources", () => fs.rm(directory, { recursive: true, force: true }))
  const html = await Bun.file(path.resolve(source, "../organization.html")).text()
  await Bun.write(
    path.join(directory, "organization.html"),
    html.replace("/src/organization/entry.tsx", `/@fs/${source}/organization/entry.tsx`),
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<button id="connect">Connect</button><textarea id="draft">Unsent draft</textarea><script type="module" src="/main.ts"></script>',
  )
  await Bun.write(
    path.join(directory, "main.ts"),
    `
    import { authorizeOrganization } from ${JSON.stringify(`/@fs/${source}/organization/authorization.ts`)}
    import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
    let tokens
    window.fixture = {
      issuer: "", account: null, error: null,
      async begin() {
        this.error = null
        try {
          tokens = await authorizeOrganization({ issuer: this.issuer, clientID: "web", redirectUri: location.origin + "/organization.html" })
          this.account = tokens.account
        } catch (error) { this.error = error.code }
      },
      async inspect() {
        const client = createOrganizationClient({ baseUrl: this.issuer, credentials: "omit", headers: { authorization: "Bearer " + tokens.accessToken } })
        return (await client.orgOrganization.get()).data
      },
      async logout() {
        const client = createOrganizationClient({ baseUrl: this.issuer, credentials: "omit", headers: { authorization: "Bearer " + tokens.accessToken } })
        const result = await client.orgAuth.logout({ orgEmptyInput: {} })
        if (!result.data?.ok) throw new Error("Logout failed")
        const old = await client.orgAuth.session()
        tokens = undefined
        this.account = null
        return old.response.status
      }
    }
    document.getElementById("connect").onclick = () => void window.fixture.begin()
  `,
  )
  const fixture = await createBrowserFixture({
    root: directory,
    entries: ["index.html", "organization.html"],
    styled: true,
    aliases: [{ find: "@", replacement: source }],
  })
  resources.defer("compiled fixture HTTP listener", fixture.close)
  const server = createServer({ key, cert }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "https://fixture.example").pathname
      const filename = path.resolve(fixture.directory, `.${pathname === "/" ? "/index.html" : pathname}`)
      if (!filename.startsWith(fixture.directory + path.sep)) return response.writeHead(404).end()
      const file = Bun.file(filename)
      if (!(await file.exists())) return response.writeHead(404).end()
      response.setHeader("content-type", file.type)
      response.setHeader("referrer-policy", "no-referrer")
      response.setHeader(
        "content-security-policy",
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${authority?.issuer ?? ""}; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'`,
      )
      response.end(Buffer.from(await file.arrayBuffer()))
    })().catch(() => response.writeHead(500).end())
  })
  resources.defer(
    "client HTTPS listener",
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  clientOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--no-env-file",
      `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      path.resolve(import.meta.dir, "../fixtures/organization-service.ts"),
    ],
    {
      env: isolated.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(child.stderr).text()
  resources.defer("organization service process", async () => {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      await child.exited
    } finally {
      clearTimeout(timer)
    }
  })
  child.stdin.write(
    JSON.stringify({ home: isolated.env.SYNERGY_TEST_HOME, directory: fixture.directory, clientOrigin, key, cert }),
  )
  await child.stdin.end()
  const lines = createInterface({ input: Readable.from(child.stdout) })
  try {
    const iterator = lines[Symbol.asyncIterator]()
    const result = await Promise.race([
      iterator.next(),
      child.exited.then(async (code) => {
        throw new Error(`Organization fixture exited ${code}: ${await errors}`)
      }),
    ])
    if (result.done) throw new Error("Organization fixture did not become ready")
    authority = JSON.parse(result.value)
  } finally {
    lines.close()
  }
  browser = await chromium.launch({ headless: true, args: ["--test-third-party-cookie-phaseout"] })
  resources.defer("authorization browser", () => browser.close())
}, 120_000)

afterAll(() => resources.close())

test("real HTTPS popup login, callback, cookie recovery and explicit logout use no personal Runtime or persistent token", async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 740 } })
  const page = await context.newPage()
  const requested: string[] = []
  let bearer = ""
  context.on("request", (request) => requested.push(new URL(request.url()).pathname))
  context.on("response", (response) => {
    if (new URL(response.url()).pathname === "/org/v1/auth/exchange" && response.ok())
      void response.json().then((data) => {
        bearer = data.accessToken
      })
  })
  try {
    await page.goto(clientOrigin)
    await page.waitForFunction(() => Boolean((window as unknown as { fixture?: unknown }).fixture))
    const configure = () =>
      page.evaluate((issuer) => {
        ;(window as unknown as { fixture: { issuer: string } }).fixture.issuer = issuer
      }, authority.issuer)
    await configure()
    const open = async () => {
      const opened = page.waitForEvent("popup")
      await page.locator("#connect").click()
      const popup = await opened
      popup.setDefaultTimeout(15_000)
      await popup.setViewportSize({ width: 375, height: 740 })
      return popup
    }
    const popup = await open()
    await popup.getByLabel("Account", { exact: true }).fill("owner")
    await popup.getByLabel("Password", { exact: true }).fill("organization browser fixture password")
    expect(new URL(popup.url()).hash).toBe("")
    await popup.screenshot({ path: path.join(screenshots, "sign-in.png") })
    await popup.emulateMedia({ colorScheme: "dark" })
    await popup.waitForFunction(() => document.documentElement.getAttribute("data-color-scheme") === "dark")
    await popup.screenshot({ path: path.join(screenshots, "sign-in-dark.png") })
    await popup.emulateMedia({ colorScheme: "light" })
    await popup.getByRole("button", { name: "Sign in", exact: true }).click()
    await popup.getByText("Fixture owner", { exact: true }).waitFor()
    expect(await popup.getByText(`Connect this account to ${clientOrigin}.`, { exact: true }).count()).toBe(1)
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await popup.screenshot({ path: path.join(screenshots, "approval.png") })
    await popup.getByRole("button", { name: "Continue", exact: true }).click()
    await page.waitForFunction(() => Boolean((window as unknown as { fixture: { account: unknown } }).fixture.account))
    expect(await page.locator("#connect").evaluate((element) => element === document.activeElement)).toBe(true)
    expect(
      await page.evaluate(() => (window as unknown as { fixture: { inspect(): Promise<unknown> } }).fixture.inspect()),
    ).toMatchObject({ name: "Browser fixture", orgID: authority.orgID })
    const cookies = await context.cookies(authority.issuer)
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__Host-synergy_org_session", httpOnly: true, secure: true, sameSite: "Lax" }),
      ]),
    )
    expect(await context.cookies(clientOrigin)).toEqual([])
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    )
    expect(bearer).toMatch(/^[a-f0-9]{64}$/)
    expect(stored).not.toContain(bearer)
    expect(stored).not.toContain("organization browser fixture password")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as unknown as { fixture?: unknown }).fixture))
    await configure()
    const restored = await open()
    await restored.getByRole("button", { name: "Continue", exact: true }).waitFor()
    expect(await restored.getByLabel("Password", { exact: true }).count()).toBe(0)
    await restored.getByRole("button", { name: "Continue", exact: true }).click()
    await page.waitForFunction(() => Boolean((window as unknown as { fixture: { account: unknown } }).fixture.account))
    expect(
      await page.evaluate(() => (window as unknown as { fixture: { logout(): Promise<number> } }).fixture.logout()),
    ).toBe(401)
    const signedOut = await open()
    await signedOut.getByLabel("Password", { exact: true }).waitFor()
    await signedOut.close()
    await page.waitForFunction(
      () => (window as unknown as { fixture: { error: string } }).fixture.error === "popup_unavailable",
    )
    expect(await page.locator("#draft").inputValue()).toBe("Unsent draft")
    expect(requested.some((pathname) => pathname.startsWith("/global/") || pathname.startsWith("/session"))).toBe(false)
    expect(requested.filter((pathname) => pathname === "/org/v1/auth/exchange")).toHaveLength(2)
  } finally {
    await context.close()
  }
}, 60_000)

test("an isolated callback clears its code and offers recovery in both themes and Chinese", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: "zh-CN",
      colorScheme,
      viewport: { width: 375, height: 640 },
    })
    const page = await context.newPage()
    try {
      const code = {
        ...authority,
        clientID: "web",
        redirectUri: `${clientOrigin}/organization.html`,
        state: "s".repeat(43),
        code: "b".repeat(64),
        expiresAt: Date.now() + 60_000,
      }
      await page.goto(`${code.redirectUri}#code=${encodeURIComponent(JSON.stringify(code))}`)
      await page.getByRole("status").waitFor()
      expect(await page.getByRole("status").innerText()).toContain("返回 Synergy")
      expect(new URL(page.url()).hash).toBe("")
      expect(await page.evaluate(() => document.documentElement.getAttribute("data-color-scheme"))).toBe(colorScheme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: path.join(screenshots, `callback-${colorScheme}.png`) })
      await page.keyboard.press("Tab")
      expect(
        await page.getByRole("button", { name: "关闭窗口" }).evaluate((element) => element === document.activeElement),
      ).toBe(true)
    } finally {
      await context.close()
    }
  }
}, 30_000)
