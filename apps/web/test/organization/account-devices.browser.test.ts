import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import {
  OrganizationDesktop as Desktop,
  OrganizationHandoffRecovery as Recovery,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const connection: Desktop.Connection = {
  id: "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: "https://organization.example",
  clientID: "desktop",
  orgID: "org",
  deploymentIncarnation: "inc",
  account: {
    accountID: "account",
    orgID: "org",
    loginName: "owner",
    displayName: "Owner",
    role: "owner",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}
const self = Runtime.MemberRegistrationRecord.parse({
  runtimeID: "self",
  orgID: "org",
  deploymentIncarnation: "inc",
  runtimeKind: "member",
  accountID: "account",
  deviceID: "This-computer",
  publicKey: "a".repeat(64),
  state: "active",
  revision: 1,
  connectionEpoch: 1,
  createdAt: 0,
})
const descriptor = Recovery.Descriptor.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "old-move",
  sessionID: "private-session",
  sourceRuntimeID: "original-source",
  targetRuntimeID: "self",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 0,
  manifestHash: "b".repeat(64),
})
const response = (body: unknown) => ({ ok: true, value: { status: 200, body: JSON.stringify(body) } })
async function capture(page: Page, control: Locator, name: string) {
  const output = process.env.SYNERGY_UI_SCREENSHOT_DIR
  if (!output) return
  await fs.mkdir(output, { recursive: true })
  const state = await control.evaluate((element) => {
    const backgrounds = []
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      backgrounds.push({ tag: current.tagName, background: style.backgroundColor, opacity: style.opacity })
    }
    const style = getComputedStyle(element)
    return {
      label: element.textContent,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      ariaBusy: element.getAttribute("aria-busy"),
      color: style.color,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      backgrounds,
    }
  })
  await Bun.write(path.join(output, name.replace(/\.png$/, "-control.json")), JSON.stringify(state, null, 2))
  await page.screenshot({ path: path.join(output, name), animations: "disabled" })
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-account-devices-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"; import {Show} from "solid-js";
    import {AppBaseProviders} from ${JSON.stringify(`/@fs/${source}/app.tsx`)};
    import {SpaceProvider,useSpace} from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)};
    import {PlatformProvider} from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)};
    import {OrganizationAccount} from ${JSON.stringify(`/@fs/${source}/organization/account.tsx`)};
    import {organizationDeviceMessages as copy} from ${JSON.stringify(`/@fs/${source}/organization/account-device-messages.ts`)};
    import {organizationNativeHandoffMessages as nativeCopy} from ${JSON.stringify(`/@fs/${source}/organization/handoff-native-messages.ts`)};
    import {useLingui} from "@lingui/solid";
    const platform={platform:"web",openLink(){},fetch:async()=>Response.json({healthy:false}),organization:{protocolVersion:2,list:()=>window.hostList(),request:async value=>{const result=await window.hostRequest(value);window.accountResponses=(window.accountResponses??0)+1;return result},cancel:()=>Promise.resolve({ok:true}),startMember:()=>{throw new Error("No automatic Runtime start")}}};
    function Fixture(){const {_}=useLingui();window.deviceCopy=key=>_(copy[key]);window.nativeDeviceCopy=key=>_(nativeCopy[key]);const space=useSpace();return <Show when={space.current()?.key} keyed>{key=><main style={{padding:"16px",height:"100vh",overflow:"auto","box-sizing":"border-box"}}><OrganizationAccount/></main>}</Show>}
    render(()=><PlatformProvider value={platform}><AppBaseProviders><SpaceProvider><Fixture/></SpaceProvider></AppBaseProviders></PlatformProvider>,document.getElementById("root"));
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
  console.info("Account devices immutable fixture ready", path.basename(fixture.directory))
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function open(
  input: {
    revoked?: boolean
    foreignFirst?: boolean
    errorOnce?: boolean
    indexedFact?: boolean
    holdCleanup?: Promise<void>
    viewport?: { width: number; height: number }
    locale?: string
    colorScheme?: "light" | "dark"
  } = {},
) {
  const context = await browser.newContext({
    viewport: input.viewport ?? { width: 1100, height: 760 },
    locale: input.locale ?? "en-US",
    colorScheme: input.colorScheme ?? "light",
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const requests: Array<{ path: string; method: string; connectionID: string }> = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const cleanupRequested = Promise.withResolvers<void>()
  const alternate = {
    ...connection,
    id: "d".repeat(64),
    account: {
      ...connection.account,
      accountID: "another-account",
      loginName: "another",
      displayName: "Another member",
      role: "member" as const,
    },
  }
  let failed = false
  await context.exposeFunction("hostList", () => ({ ok: true, value: [connection, alternate] }))
  await context.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const url = new URL(request.path, connection.issuer)
    requests.push({ path: url.pathname + url.search, method: request.method, connectionID: request.connectionID })
    if (url.pathname === "/org/v1/invites") return response({ items: [] })
    if (url.pathname === "/org/v1/runtimes") {
      if (input.errorOnce && !failed) {
        failed = true
        return { ok: true, value: { status: 503, body: JSON.stringify({ code: "SERVICE_UNAVAILABLE" }) } }
      }
      if (request.connectionID === alternate.id)
        return response({
          items: [{ ...self, runtimeID: "another-self", accountID: "another-account", deviceID: "Second-computer" }],
        })
      const foreign = { ...self, runtimeID: "foreign", accountID: "someone-else", deviceID: "Another-members-computer" }
      if (input.foreignFirst && !url.searchParams.has("cursor"))
        return response({ items: [foreign], cursor: "devices-next" })
      return response({ items: [{ ...self, state: input.revoked ? "revoked" : "active" }, foreign] })
    }
    if (url.pathname === "/org/v1/runtimes/self") return response(self)
    if (url.pathname === "/org/v1/runtimes/self/handoff-cleanups") {
      if (input.holdCleanup) {
        cleanupRequested.resolve()
        await input.holdCleanup
      }
      return response(
        url.searchParams.has("cursor")
          ? { items: [{ ...descriptor, ...(input.indexedFact ? { cleanupFactHash: "f".repeat(64) } : {}) }] }
          : { items: [], cursor: "original-next" },
      )
    }
    if (url.pathname === "/org/v1/handoffs/old-move/drive") {
      const body = JSON.parse(request.body!)
      if (body.operation !== "inspect-target") throw new Error("Only original cleanup inspection is allowed")
      return response({
        handoffID: "old-move",
        runtimeID: "self",
        requestID: body.requestID,
        operation: "inspect-target",
        state: "blocked",
        stage: "preparing",
        revision: "c".repeat(64),
        requirements: [],
        facts: [],
      })
    }
    throw new Error(`No Session, project execution or machine recovery authority: ${request.method} ${url.pathname}`)
  })
  await page.goto(new URL("/organization/org/account/inc", fixture.url).href)
  await page.locator(".organization-account-view h2").waitFor()
  if (input.locale?.startsWith("zh")) await page.waitForFunction(() => document.documentElement.lang === "zh-CN")
  return {
    page,
    requests,
    errors,
    cleanupRequested: cleanupRequested.promise,
    close: () => context.close(),
    copy(key: string, native = false) {
      return page.evaluate(
        ({ key, native }) => {
          const translate = Reflect.get(window, native ? "nativeDeviceCopy" : "deviceCopy")
          if (typeof translate !== "function") throw new Error("The actual locale owner is unavailable")
          const value = translate(key)
          if (typeof value !== "string") throw new Error("The actual locale owner returned no label")
          return value
        },
        { key, native },
      )
    },
  }
}

test("account devices discover only self cleanup pages without opening a Session or borrowing administrator authority", async () => {
  const f = await open({ foreignFirst: true })
  try {
    expect(await f.page.getByRole("heading", { name: "My computers", exact: true }).count()).toBe(1)
    expect(f.requests.some((request) => request.path.startsWith("/org/v1/runtimes"))).toBe(false)
    await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
    await f.page.getByRole("button", { name: "Next computers", exact: true }).click()
    await f.page.getByText("This-computer", { exact: true }).waitFor()
    expect(await f.page.getByText("Another-members-computer", { exact: true }).count()).toBe(0)
    await f.page.getByRole("button", { name: "Find cancelled moves", exact: true }).click()
    await f.page.getByRole("button", { name: "Next moves", exact: true }).click()
    await f.page.getByRole("button", { name: "Inspect preparation", exact: true }).click()
    const dialog = f.page.getByRole("dialog", { name: "Destination preparation", exact: true })
    const received = await f.page.evaluate(() => Number(Reflect.get(window, "accountResponses") ?? 0))
    await dialog.getByRole("button", { name: "Check destination cleanup", exact: true }).click()
    await f.page.waitForFunction(
      (received) => Number(Reflect.get(window, "accountResponses") ?? 0) > received,
      received,
    )
    expect(f.requests.some((request) => /sessions|projects|\/runtime\//.test(request.path))).toBe(false)
    expect(f.requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
      "/org/v1/handoffs/old-move/drive",
    ])
    expect(f.errors).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

test("revoked computers expose only the original-installation explanation and no human recovery action", async () => {
  const f = await open({ revoked: true })
  try {
    await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
    await f.page.getByText("Access revoked", { exact: true }).waitFor()
    expect(
      await f.page
        .getByText(
          "Only the original Synergy installation on this computer can finish cleaning up its cancelled moves.",
          { exact: true },
        )
        .isVisible(),
    ).toBe(true)
    expect(await f.page.getByRole("button", { name: "Find cancelled moves", exact: true }).count()).toBe(0)
    expect(await f.page.getByRole("button", { name: /recover|restore/i }).count()).toBe(0)
    expect(f.requests.some((request) => request.path.includes("handoff"))).toBe(false)
    expect(f.errors).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

test("collapsing or switching accounts retires a held cleanup reply without restoring its page or focus", async () => {
  for (const changeAccount of [false, true]) {
    const held = Promise.withResolvers<void>()
    const f = await open({ holdCleanup: held.promise })
    try {
      await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
      await f.page.getByText("This-computer", { exact: true }).waitFor()
      await f.page.getByRole("button", { name: "Find cancelled moves", exact: true }).click()
      await f.cleanupRequested
      if (changeAccount) {
        await f.page.evaluate(() => {
          history.pushState(null, "", "/organization/org/another-account/inc")
          window.dispatchEvent(new PopStateEvent("popstate"))
        })
        await f.page.getByText("Another member · another", { exact: true }).waitFor()
      } else {
        await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
        await f.page.locator(".organization-devices").waitFor({ state: "detached" })
      }
      await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
      await f.page.getByText(changeAccount ? "Second-computer" : "This-computer", { exact: true }).waitFor()
      const trigger = f.page.getByRole("button", { name: "Find cancelled moves", exact: true })
      await trigger.focus()
      const before = await f.page.evaluate(() => Number(Reflect.get(window, "accountResponses") ?? 0))
      held.resolve()
      await f.page.waitForFunction((before) => Number(Reflect.get(window, "accountResponses") ?? 0) > before, before)
      await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      expect(await f.page.getByRole("region", { name: "Cancelled moves", exact: true }).count()).toBe(0)
      expect(await f.page.getByRole("dialog").count()).toBe(0)
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
      expect(f.requests.filter((request) => request.path.includes("handoff-cleanups"))).toHaveLength(1)
      expect(f.errors).toEqual([])
    } finally {
      held.resolve()
      await f.close()
    }
  }
}, 45_000)

test("an explicit read retry preserves the device page after a failed registry lookup", async () => {
  const f = await open({ errorOnce: true })
  try {
    await f.page.getByRole("heading", { name: "My computers", exact: true }).click()
    await f.page.getByRole("alert").waitFor()
    await f.page.getByRole("button", { name: "Retry", exact: true }).click()
    await f.page.getByText("This-computer", { exact: true }).waitFor()
    expect(
      f.requests.filter((request) => request.path.startsWith("/org/v1/runtimes?") && request.method === "GET"),
    ).toHaveLength(2)
    expect(f.requests.some((request) => request.method === "POST")).toBe(false)
    expect(f.errors).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

test("the real Chinese account device pages and cleanup dialog remain reachable on desktop and narrow themes", async () => {
  for (const variant of [
    { viewport: { width: 1100, height: 760 }, colorScheme: "light" as const },
    { viewport: { width: 375, height: 667 }, colorScheme: "light" as const },
    { viewport: { width: 375, height: 667 }, colorScheme: "dark" as const },
  ]) {
    const f = await open({ ...variant, locale: "zh-CN", indexedFact: true })
    const name = `account-devices-zh-${variant.colorScheme}-${variant.viewport.width}`
    try {
      const title = f.page.getByRole("heading", { name: await f.copy("title"), exact: true })
      expect(await title.innerText()).toMatch(/[\u3400-\u9fff]/)
      await title.click()
      await f.page.getByText("This-computer", { exact: true }).waitFor()
      await f.page.getByRole("button", { name: await f.copy("find"), exact: true }).click()
      await f.page.getByRole("button", { name: await f.copy("nextMoves"), exact: true }).click()
      const inspect = f.page.getByRole("button", { name: await f.copy("inspect"), exact: true })
      await inspect.scrollIntoViewIfNeeded()
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      expect(
        await f.page.locator(".organization-devices button").evaluateAll((buttons) =>
          buttons.every((button) => {
            const rect = button.getBoundingClientRect()
            return rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth + 1)
          }),
        ),
      ).toBe(true)
      expect(await inspect.isEnabled()).toBe(true)
      await capture(f.page, inspect, `${name}-page.png`)
      const returnFocus = await inspect.elementHandle()
      if (!returnFocus) throw new Error("The original cleanup row is not connected")
      await inspect.click()
      const dialog = f.page.getByRole("dialog", { name: await f.copy("cleanup", true), exact: true })
      const check = dialog.getByRole("button", { name: await f.copy("checkCleanup", true), exact: true })
      const before = await f.page.evaluate(() => Number(Reflect.get(window, "accountResponses") ?? 0))
      await check.scrollIntoViewIfNeeded()
      await check.click()
      await f.page.waitForFunction((before) => Number(Reflect.get(window, "accountResponses") ?? 0) > before, before)
      await f.page.waitForFunction(
        (button) => button instanceof HTMLButtonElement && button.isConnected && !button.disabled,
        await check.elementHandle(),
      )
      expect(await check.isEnabled()).toBe(true)
      expect(await dialog.getByText(await f.copy("cleanupUnknown", true), { exact: true }).isVisible()).toBe(true)
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await capture(f.page, check, `${name}-dialog.png`)
      await f.page.keyboard.press("Escape")
      await dialog.waitFor({ state: "detached" })
      await f.page.waitForFunction((button) => button.isConnected && button === document.activeElement, returnFocus)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  }
}, 60_000)
