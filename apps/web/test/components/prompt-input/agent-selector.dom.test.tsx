import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".agent-selector-"))
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(directory, "locale.ts"),
      'import { useLingui } from "@lingui/solid"; export const useLocale = () => ({ i18n: { _: useLingui()._ } })',
    ),
    Bun.write(
      path.join(directory, "local.ts"),
      `
      import { createSignal } from "solid-js"
      const agents = [{ name: "atlas" }, { name: "forge" }, { name: "external-fixture", external: { adapter: "codex" } }, { name: "hidden-fixture", hidden: true }]
      const [name, setName] = createSignal("atlas")
      export const [changes, setChanges] = createSignal(0)
      export const useLocal = () => ({ agent: {
        current: () => agents.find(agent => agent.name === name()),
        list: () => agents,
        set: value => { setName(value); setChanges(count => count + 1) },
      } })
      `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { createSignal } from "solid-js"
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { useLocal, changes } from "./local"
      import { AgentSelector } from ${JSON.stringify(`/@fs/${source}/components/prompt-input/agent-selector.tsx`)}
      import "@ericsanchezok/synergy-ui/styles"
      import ${JSON.stringify(`/@fs/${source}/index.css`)}
      const params = new URLSearchParams(location.search)
      const [hasMessages, setHasMessages] = createSignal(params.has("messages"))
      const messages = params.has("translated") ? {
        "app.agent.role.general": "Localized general",
        "app.agent.description.general": "Localized general description",
        "app.agent.role.coding": "Localized engineering",
        "app.agent.description.coding": "Localized engineering description",
      } : {}
      const local = useLocal()
      render(() => <I18nProvider i18n={setupI18n({ locale: "en", messages: { en: messages } })}>
        <div class="synergy-workbench-canvas" style="min-height:100dvh;padding:24px;background:var(--background-stronger)">
          <button onClick={() => setHasMessages(true)}>Start session</button>
          <div class="prompt-input-shell" style="margin-top:320px;max-width:600px">
            <div class="prompt-input-toolbar flex items-center"><AgentSelector hasMessages={hasMessages} /></div>
          </div>
          <output aria-label="Saved agent">{local.agent.current()?.name}</output>
          <output aria-label="Agent changes">{changes()}</output>
        </div>
      </I18nProvider>, document.getElementById("root"))
      `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@/context/local", replacement: path.join(directory, "local.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid", "fuzzysort"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 375, height: 720 }, reducedMotion: "reduce" })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator(".prompt-input-toolbar-button").waitFor({ timeout: 15000 })
}, 30_000)

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60_000)

test("agent choices filter hidden entries, select by pointer and keyboard, and keep a compact upward trigger", async () => {
  const trigger = page.locator(".prompt-input-toolbar-button")
  expect(await trigger.textContent()).toBe("Atlas")
  expect(await trigger.locator("svg").count()).toBe(0)
  await trigger.hover()
  await page.getByRole("tooltip", { name: "Select agent", exact: true }).waitFor()
  await trigger.click()
  await page.getByRole("tooltip").waitFor({ state: "detached" })
  const listbox = page.getByRole("listbox", { name: "Select agent", exact: true })
  await listbox.waitFor()
  expect(await listbox.getByRole("option").count()).toBe(3)
  expect(await page.getByRole("option", { name: /Hidden/ }).count()).toBe(0)
  expect(await listbox.getByRole("textbox").count()).toBe(0)
  const bounds = await page.getByRole("dialog").boundingBox()
  const anchor = await trigger.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(288)
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(anchor!.y)
  await page.getByRole("option", { name: "Codex", exact: true }).click()
  await listbox.waitFor({ state: "detached" })
  expect(await page.getByLabel("Saved agent").textContent()).toBe("external-fixture")
  expect(await trigger.getAttribute("aria-label")).toBe("Select agent: Codex")
  await trigger.press("ArrowUp")
  await page.getByRole("option", { name: "Codex", exact: true }).click()
  await listbox.waitFor({ state: "detached" })
  expect(await page.getByLabel("Agent changes").textContent()).toBe("1")
  await trigger.press("ArrowDown")
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option")
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  expect(await page.getByLabel("Saved agent").textContent()).toBe("forge")
  await trigger.press("ArrowUp")
  await listbox.waitFor()
  await page.keyboard.press("Escape")
  await listbox.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.classList.contains("prompt-input-toolbar-button"))
  expect(await trigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("external agents become disabled after messages while retaining their explanation", async () => {
  const trigger = page.locator(".prompt-input-toolbar-button")
  await trigger.click()
  const external = page.getByRole("option", { name: "Codex", exact: true })
  await external.waitFor()
  expect(await external.getAttribute("aria-disabled")).not.toBe("true")
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  expect(await external.getAttribute("aria-disabled")).toBe("true")
  await external.locator('[data-component="tooltip-trigger"]').hover()
  await page.getByRole("tooltip", { name: "Create a new session to use this external agent", exact: true }).waitFor()
  await external.evaluate((element) => (element as HTMLElement).click())
  expect(await page.getByLabel("Agent changes").textContent()).toBe("0")
  expect(await page.getByLabel("Saved agent").textContent()).toBe("atlas")
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  await page.getByRole("option", { name: /^Atlas/ }).focus()
  await page.keyboard.press("End")
  expect(await page.getByRole("option", { name: /^Forge/ }).getAttribute("data-highlighted")).toBe("")
  await page.keyboard.press("Enter")
  expect(await page.getByLabel("Saved agent").textContent()).toBe("forge")
  expect(errors).toEqual([])
}, 30_000)

test("agent translations and shared selection, hover and keyboard surfaces survive both themes", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?translated`)
  const trigger = page.getByRole("button", { name: "Select agent: Localized general", exact: true })
  await trigger.click()
  const selected = page.getByRole("option", { name: "Localized general Localized general description", exact: true })
  const engineering = page.getByRole("option", {
    name: "Localized engineering Localized engineering description",
    exact: true,
  })
  const colors: string[] = []
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await engineering.hover()
    expect(await selected.getAttribute("aria-selected")).toBe("true")
    expect(await selected.locator('[data-slot="menu-field-indicator"]').count()).toBe(1)
    expect(await selected.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
    expect(await engineering.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    )
    if (process.env.SYNERGY_VISUAL_OUTPUT) {
      await page.screenshot({ path: path.join(process.env.SYNERGY_VISUAL_OUTPUT, `agent-${colorScheme}.png`) })
    }
    await page.keyboard.press("Home")
    expect(await selected.getAttribute("data-highlighted")).toBe("")
    expect(await page.getByLabel("Agent changes").textContent()).toBe("0")
    colors.push(await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).backgroundColor))
  }
  expect(colors[0]).not.toBe(colors[1])
  await engineering.click()
  expect(await trigger.count()).toBe(0)
  expect(await page.getByRole("button", { name: "Select agent: Localized engineering", exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
}, 30_000)
