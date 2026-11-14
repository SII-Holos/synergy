import { beforeAll, afterAll, expect, test } from "bun:test"
import { z } from "zod"
import { OrganizationClientAuth } from "@ericsanchezok/synergy-organization-protocol"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:https"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { chromium, type Browser, type Page } from "playwright"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { createBrowserFixture } from "../support/browser-fixture"
import { key, cert } from "../fixtures/organization-tls"

const source = path.resolve(import.meta.dir, "../../src")
const screenshots =
  process.env.SYNERGY_UI_SCREENSHOT_DIR ??
  path.resolve(source, "../../../.artifacts/testing/organization-authorization")
const resources = testResources()
let browser: Browser
let clientOrigin: string
const Authority = z.strictObject({
  issuer: z.string().url(),
  orgID: z.string().min(1),
  deploymentIncarnation: z.string().min(1),
  projectID: z.string().min(1).optional(),
})
type Authority = z.infer<typeof Authority>
let authority: Authority
let secondary: Authority

beforeAll(async () => {
  await fs.mkdir(screenshots, { recursive: true })
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
  await Bun.write(
    path.join(directory, "app.html"),
    '<!doctype html><html><head><script>const fixtureURL=new URL(location.href);fixtureURL.searchParams.set("url",location.origin);history.replaceState(null,"",fixtureURL)</script></head><body><div id="root"></div><script type="module" src="/app.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "app.tsx"),
    `
    import { render } from "solid-js/web"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    render(() => <PlatformProvider value={{platform:"web",openLink(){}}}><AppBaseProviders><AppInterface /></AppBaseProviders></PlatformProvider>, document.getElementById("root"))
  `,
  )
  const fixture = await createBrowserFixture({
    root: directory,
    entries: ["index.html", "organization.html", "app.html"],
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  resources.defer("compiled fixture HTTP listener", fixture.close)
  const server = createServer({ key, cert }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "https://fixture.example").pathname
      const app = pathname === "/app.html" || pathname.startsWith("/organization/")
      const filename = path.resolve(
        fixture.directory,
        `.${app ? "/app.html" : pathname === "/" ? "/index.html" : pathname}`,
      )
      if (!filename.startsWith(fixture.directory + path.sep)) return response.writeHead(404).end()
      const file = Bun.file(filename)
      if (!(await file.exists())) return response.writeHead(404).end()
      response.setHeader("content-type", file.type)
      response.setHeader("referrer-policy", "no-referrer")
      response.setHeader(
        "content-security-policy",
        `default-src 'self'; script-src 'self' ${app ? "'unsafe-inline' 'wasm-unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; connect-src 'self' ${[authority?.issuer, secondary?.issuer].filter(Boolean).join(" ")}; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'`,
      )
      if (app)
        return response.end(
          (await file.text()).replace(
            "<head>",
            `<head><script>window.__SYNERGY_WEB_CONNECT_ORIGINS__=${JSON.stringify([authority.issuer, secondary.issuer])}</script>`,
          ),
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
  async function startAuthority(
    options: { issuerHost?: "127.0.0.1"; organizationName?: string; projectName?: null } = {},
  ) {
    const isolated = await createIsolatedTestEnv()
    resources.defer("organization authority Home", isolated.dispose)
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--no-env-file",
        `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        path.resolve(import.meta.dir, "../fixtures/organization-service.ts"),
      ],
      { env: isolated.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
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
      JSON.stringify({
        home: isolated.env.SYNERGY_TEST_HOME,
        directory: fixture.directory,
        clientOrigin,
        key,
        cert,
        ...options,
      }),
    )
    await child.stdin.end()
    const lines = createInterface({ input: Readable.from(child.stdout) })
    try {
      const result = await Promise.race([
        lines[Symbol.asyncIterator]().next(),
        child.exited.then(async (code) => {
          throw new Error(`Organization fixture exited ${code}: ${await errors}`)
        }),
      ])
      if (result.done) throw new Error("Organization fixture did not become ready")
      return Authority.parse(JSON.parse(result.value))
    } finally {
      lines.close()
    }
  }
  authority = await startAuthority()
  secondary = await startAuthority({
    issuerHost: "127.0.0.1",
    organizationName: "Second organization",
    projectName: null,
  })
  browser = await chromium.launch({
    headless: true,
    args: ["--test-third-party-cookie-phaseout"],
  })
  console.info(
    "organization-browser-fixture",
    JSON.stringify({ artifact: path.basename(fixture.directory), authorities: 2, headless: true }),
  )
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
      const code = OrganizationClientAuth.Code.parse({
        issuer: authority.issuer,
        orgID: authority.orgID,
        deploymentIncarnation: authority.deploymentIncarnation,
        clientID: "web",
        redirectUri: `${clientOrigin}/organization.html`,
        state: "s".repeat(43),
        code: "b".repeat(64),
        expiresAt: Date.now() + 60_000,
      })
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

test("the real Web space signs in, restores its project deep link and stays signed out after reload", async () => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "en",
    viewport: { width: 1100, height: 760 },
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    page.setDefaultTimeout(15_000)
    await page.goto(`${clientOrigin}/app.html`)
    await page.getByRole("button", { name: "Current space" }).click()
    await page.getByRole("menuitem", { name: "Connect organization" }).click()
    expect(await page.getByLabel("Organization address").inputValue()).toBe("")
    await page.getByLabel("Organization address").fill(authority.issuer)
    await page.locator(".organization-connect-advanced summary").click()
    await page.getByLabel("Client ID").fill("web")
    const opened = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Connect organization", exact: true }).click()
    const popup = await opened
    await popup.getByLabel("Account", { exact: true }).fill("owner")
    await popup.getByLabel("Password", { exact: true }).fill("organization browser fixture password")
    await popup.getByRole("button", { name: "Sign in", exact: true }).click()
    await popup.getByRole("button", { name: "Continue", exact: true }).click()
    await page.getByRole("button", { name: /Shared project/ }).click()
    await page.getByRole("heading", { name: "Shared project" }).waitFor()
    const projectURL = new URL(page.url()).pathname
    const stored = await page.evaluate(() => localStorage.getItem("synergy.global.dat:organization-connections"))
    expect(stored).toContain("Fixture owner")
    expect(stored).not.toMatch(/accessToken|refreshToken|verifier|password/)
    await page.reload()
    await page.getByRole("button", { name: "Restore organization connection" }).waitFor()
    expect(context.pages()).toHaveLength(1)
    expect(await page.getByRole("heading", { name: "Shared project" }).count()).toBe(0)
    const recovery = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Restore organization connection" }).click()
    const restored = await recovery
    await restored.getByRole("button", { name: "Continue", exact: true }).waitFor()
    expect(await restored.getByLabel("Password", { exact: true }).count()).toBe(0)
    await restored.getByRole("button", { name: "Continue", exact: true }).click()
    await page.getByRole("heading", { name: "Shared project" }).waitFor()
    expect(new URL(page.url()).pathname).toBe(projectURL)
    await page.getByRole("button", { name: "Sign out", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click()
    await page.getByRole("heading", { name: "Signed out", exact: true }).waitFor()
    await page.reload()
    await page.getByRole("heading", { name: "Signed out", exact: true }).waitFor()
    expect(context.pages()).toHaveLength(1)
    const relogin = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Restore organization connection" }).click()
    const signedOut = await relogin
    await signedOut.getByLabel("Password", { exact: true }).waitFor()
    await signedOut.close()
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
}, 45_000)

const variants = [
  {
    locale: "en",
    colorScheme: "light" as const,
    width: 1100,
    height: 780,
    name: "en-wide",
    words: {
      current: "Current space",
      personal: "Personal space",
      connect: "Connect organization",
      address: "Organization address",
      account: "Account",
      password: "Password",
      signIn: "Sign in",
      continue: "Continue",
      back: "Back to personal space",
      empty: "A shared place to move work forward",
    },
  },
  {
    locale: "zh-CN",
    colorScheme: "dark" as const,
    width: 375,
    height: 740,
    name: "zh-narrow",
    words: {
      current: "当前空间",
      personal: "个人空间",
      connect: "连接组织",
      address: "组织地址",
      account: "账号",
      password: "密码",
      signIn: "登录",
      continue: "继续",
      back: "返回个人空间",
      empty: "与团队共同推进工作",
    },
  },
]

async function captureShell(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    )
  })
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    locale: document.documentElement.lang,
    theme: document.documentElement.dataset.colorScheme,
    overflow: document.documentElement.scrollWidth > innerWidth,
    controls: [
      ...document.querySelectorAll<HTMLElement>(
        ".organization-connect-panel input, .organization-connect-panel button, .space-switcher-trigger",
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          role: element.tagName,
          x: rect.x,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          color: style.color,
          background: style.backgroundColor,
          opacity: style.opacity,
          disabled:
            element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.disabled : false,
        }
      }),
  }))
  expect(layout.overflow).toBe(false)
  expect(layout.controls.every((control) => control.x >= 0 && control.right <= layout.width + 1)).toBe(true)
  await page.screenshot({ path: path.join(screenshots, `${name}.png`), animations: "disabled" })
  await fs.writeFile(path.join(screenshots, `${name}.json`), JSON.stringify(layout, null, 2))
}

for (const variant of variants) {
  test(`the complete Web shell connects two actual organizations and isolates their pages at ${variant.name}`, async () => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: variant.locale,
      colorScheme: variant.colorScheme,
      viewport: { width: variant.width, height: variant.height },
    })
    const page = await context.newPage()
    const errors: string[] = []
    const requests: Array<{ origin: string; path: string; method: string }> = []
    const tokens: string[] = []
    const exchanges: Promise<void>[] = []
    const discoveryFailures: Array<{ error: string }> = []
    page.on("pageerror", (error) => errors.push(error.message))
    context.on("request", (request) => {
      const url = new URL(request.url())
      requests.push({ origin: url.origin, path: url.pathname, method: request.method() })
    })
    context.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/org/v1/auth/discovery")
        discoveryFailures.push({ error: request.failure()?.errorText ?? "Unknown network failure" })
    })
    context.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/org/v1/auth/exchange" || !response.ok()) return
      exchanges.push(
        response
          .json()
          .then((value) => {
            tokens.push(z.object({ accessToken: z.string().min(1) }).parse(value).accessToken)
          })
          .catch((error: unknown) => {
            errors.push(error instanceof Error ? error.name : "Invalid exchange")
          }),
      )
    })
    const words = variant.words
    const current = () => page.getByRole("button", { name: words.current, exact: true })
    const menu = async () => {
      await current().click()
      await page.getByRole("menuitem", { name: words.personal, exact: true }).waitFor()
    }
    const connect = async (selected: Authority, cancelFirst = false) => {
      await menu()
      await page.getByRole("menuitem", { name: words.connect, exact: true }).click()
      const form = page.locator(".organization-connect-panel")
      await page.getByRole("heading", { name: words.connect, exact: true }).waitFor()
      expect(await page.getByRole("heading", { name: words.connect, exact: true }).count()).toBe(1)
      const panel = await form.boundingBox()
      if (!panel) throw new Error("The actual connection form has no layout box")
      expect(panel.width).toBeGreaterThanOrEqual(variant.width < 600 ? 280 : 380)
      expect(panel.width).toBeLessThanOrEqual(480)
      expect(Math.abs(panel.x + panel.width / 2 - variant.width / 2)).toBeLessThanOrEqual(24)
      const submit = await form.getByRole("button", { name: words.connect, exact: true }).boundingBox()
      expect(submit?.height).toBeGreaterThanOrEqual(variant.width < 600 ? 44 : 40)
      await form.getByLabel(words.address, { exact: true }).fill(selected.issuer)
      const advanced = form.locator(".organization-connect-advanced")
      expect(await advanced.locator("input").isVisible()).toBe(false)
      await form.getByLabel(words.address, { exact: true }).click()
      await page.keyboard.press("Tab")
      expect(await advanced.locator("summary").evaluate((element) => element === document.activeElement)).toBe(true)
      await page.keyboard.press("Space")
      await advanced.locator("input").waitFor()
      expect(await advanced.locator("input").inputValue()).toBe("web")
      await page.keyboard.press("Space")
      expect(await advanced.locator("input").isVisible()).toBe(false)
      await captureShell(page, `real-shell-${variant.name}-connect-${selected === authority ? "A" : "B"}`)
      const authorize = async () => {
        const opened = page.waitForEvent("popup")
        await form.getByRole("button", { name: words.connect, exact: true }).click()
        const popup = await opened
        popup.setDefaultTimeout(15_000)
        return popup
      }
      if (cancelFirst) {
        const popup = await authorize()
        await popup.getByLabel(words.account, { exact: true }).fill("owner")
        await popup.getByLabel(words.password, { exact: true }).fill("incorrect fixture password")
        const rejected = popup.waitForResponse(
          (response) => new URL(response.url()).pathname === "/org/v1/auth/login" && response.status() === 401,
        )
        await popup.getByRole("button", { name: words.signIn, exact: true }).click()
        await rejected
        await popup.getByRole("alert").waitFor()
        await popup.close()
        await form.getByRole("alert").waitFor()
        expect(await form.getByLabel(words.address, { exact: true }).inputValue()).toBe(selected.issuer)
        expect(await form.getByRole("button", { name: words.back, exact: true }).isVisible()).toBe(true)
        await captureShell(page, `real-shell-${variant.name}-connection-error`)
        await form.getByRole("button", { name: words.back, exact: true }).click()
        expect(await form.count()).toBe(0)
        await menu()
        await page.getByRole("menuitem", { name: words.connect, exact: true }).click()
        await form.getByLabel(words.address, { exact: true }).fill(selected.issuer)
      }
      const popup = await authorize()
      try {
        await popup.getByLabel(words.account, { exact: true }).fill("owner")
      } catch (cause) {
        const alerts = await form
          .getByRole("alert")
          .allTextContents()
          .catch(() => [])
        throw new Error(
          "Organization popup could not sign in: " +
            JSON.stringify({ authority: selected === authority ? "A" : "B", discoveryFailures, alerts }),
          { cause },
        )
      }
      await popup.getByLabel(words.password, { exact: true }).fill("organization browser fixture password")
      await popup.getByRole("button", { name: words.signIn, exact: true }).click()
      await popup.getByRole("button", { name: words.continue, exact: true }).click()
      await page
        .locator(".organization-workspace-identity h1")
        .filter({ hasText: selected === authority ? "Browser fixture" : "Second organization" })
        .waitFor()
      expect(new URL(page.url()).pathname).toContain(`/organization/${selected.orgID}/`)
    }
    const select = async (name: string) => {
      await menu()
      await page
        .getByRole("menuitem")
        .filter({ has: page.getByText(name, { exact: true }) })
        .click()
    }
    try {
      page.setDefaultTimeout(15_000)
      await page.goto(`${clientOrigin}/app.html`)
      await current().waitFor()
      await page.waitForFunction(
        (scheme) => document.documentElement.dataset.colorScheme === scheme,
        variant.colorScheme,
      )
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(variant.locale)
      await connect(authority, true)
      await page.getByRole("button", { name: /Shared project/ }).click()
      await page.getByRole("heading", { name: "Shared project", exact: true }).waitFor()
      const originalProjectURL = new URL(page.url()).pathname
      if (!authority.projectID) throw new Error("The actual first organization did not publish its seeded project")
      expect(originalProjectURL).toContain(authority.projectID)
      await captureShell(page, `real-shell-${variant.name}-A-project`)
      await connect(secondary)
      await page.getByRole("heading", { name: words.empty, exact: true }).waitFor()
      expect(await page.getByRole("heading", { name: "Shared project", exact: true }).count()).toBe(0)
      expect(await page.getByRole("button", { name: /Shared project/ }).count()).toBe(0)
      await captureShell(page, `real-shell-${variant.name}-B-empty`)
      if (variant.locale === "en") {
        const held = Promise.withResolvers<{ status: number; projectIDs: string[] } | { error: string }>()
        const release = Promise.withResolvers<void>()
        const delivered = Promise.withResolvers<{ failed: boolean; aborted: boolean }>()
        const projects = (url: URL) => url.origin === authority.issuer && url.pathname === "/org/v1/projects"
        await page.route(projects, async (route) => {
          try {
            const response = await route.fetch()
            const rows = z.object({ items: z.array(z.object({ projectID: z.string() })) }).parse(await response.json())
            held.resolve({ status: response.status(), projectIDs: rows.items.map((item) => item.projectID) })
            await release.promise
            await route.fulfill({ response })
            delivered.resolve({ failed: false, aborted: false })
          } catch (error) {
            held.resolve({ error: error instanceof Error ? error.name : "Unknown response" })
            delivered.resolve({ failed: true, aborted: !!route.request().failure() })
          }
        })
        try {
          await select("Browser fixture")
          const response = await held.promise
          expect("status" in response).toBe(true)
          if (!("status" in response)) throw new Error("The actual organization project response was unavailable")
          expect(response.status).toBe(200)
          expect(response.projectIDs).toContain(authority.projectID)
          await select("Second organization")
          await page.getByRole("heading", { name: words.empty, exact: true }).waitFor()
          release.resolve()
          const outcome = await delivered.promise
          expect(!outcome.failed || outcome.aborted).toBe(true)
          expect(await page.getByRole("button", { name: /Shared project/ }).count()).toBe(0)
          expect(new URL(page.url()).pathname).toContain(`/organization/${secondary.orgID}/`)
        } finally {
          release.resolve()
          await page.unroute(projects)
        }
      }
      const originalSwitcher = await current().elementHandle()
      if (!originalSwitcher) throw new Error("The original space switcher is unavailable")
      await menu()
      await page.keyboard.press("Escape")
      await page.getByRole("menuitem", { name: words.personal, exact: true }).waitFor({ state: "detached" })
      await page.waitForFunction(
        (trigger) => trigger.isConnected && trigger === document.activeElement,
        originalSwitcher,
      )
      expect(await current().evaluate((element) => element === document.activeElement)).toBe(true)
      await originalSwitcher.dispose()
      await select("Browser fixture")
      await page.getByRole("button", { name: /Shared project/ }).click()
      await page.getByRole("heading", { name: "Shared project", exact: true }).waitFor()
      expect(new URL(page.url()).pathname).toBe(originalProjectURL)
      await select("Second organization")
      await page.getByRole("heading", { name: words.empty, exact: true }).waitFor()
      if (variant.locale === "zh-CN") {
        await page.emulateMedia({ colorScheme: "light" })
        await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light")
        await captureShell(page, "real-shell-zh-narrow-B-empty-light")
      }
      await menu()
      await page.getByRole("menuitem", { name: words.personal, exact: true }).click()
      await page.waitForURL((url) => !url.pathname.startsWith("/organization/"))
      await page.locator(".organization-workspace-shell").waitFor({ state: "detached" })
      await current().waitFor()
      expect(await page.locator(".organization-workspace-shell").count()).toBe(0)
      expect(await page.getByRole("heading", { name: "Shared project", exact: true }).count()).toBe(0)
      await select("Browser fixture")
      await page.getByRole("button", { name: /Shared project/ }).click()
      await page.getByRole("heading", { name: "Shared project", exact: true }).waitFor()
      await Promise.all(exchanges)
      expect(tokens).toHaveLength(2)
      const persisted = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      )
      for (const token of tokens) expect(persisted).not.toContain(token)
      expect(persisted).not.toContain("organization browser fixture password")
      for (const selected of [authority, secondary]) {
        expect(
          requests.some((request) => request.origin === selected.issuer && request.path === "/org/v1/projects"),
        ).toBe(true)
        expect(
          requests.some((request) => request.origin === selected.issuer && request.path === "/org/v1/organization"),
        ).toBe(true)
      }
      expect(
        requests.every((request) => [clientOrigin, authority.issuer, secondary.issuer].includes(request.origin)),
      ).toBe(true)
      expect(
        requests.some((request) => request.path.includes("/commands/input") || request.path.includes("/handoff")),
      ).toBe(false)
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(variant.locale)
      expect(await page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(
        variant.locale === "zh-CN" ? "light" : variant.colorScheme,
      )
      expect(errors).toEqual([])
      await fs.writeFile(
        path.join(screenshots, `real-shell-${variant.name}-requests.json`),
        JSON.stringify(requests, null, 2),
      )
    } finally {
      await context.close()
    }
  }, 60_000)
}
