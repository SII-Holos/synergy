import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".thinking-picker-fixture-"))
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><div id="picker-layer"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { createSignal } from "solid-js"
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { ModelVariantPicker } from ${JSON.stringify(`/@fs/${source}/components/provider/model-thinking-picker.tsx`)}
      import "@ericsanchezok/synergy-ui/styles"
      import ${JSON.stringify(`/@fs/${source}/components/top-bar/session-top-bar.css`)}
      import ${JSON.stringify(`/@fs/${source}/components/settings/settings-panel.css`)}
      const core = setupI18n({ locale: "en", messages: { en: {} } })
      const params = new URLSearchParams(location.search)
      const [value, setValue] = createSignal(params.get("value") ?? "high")
      const [changes, setChanges] = createSignal(0)
      render(() => <I18nProvider i18n={core}>
        <style>{"body { margin: 0; } header { position: relative; z-index: 30; height: 48px; padding: 8px 16px; } .composer { position: relative; z-index: 40; height: 400px; background: var(--background-base); }"}</style>
        <header><ModelVariantPicker appearance={params.has("toolbar") ? "toolbar" : undefined} triggerClass={params.has("toolbar") ? "stb-selector-btn" : undefined} value={value()} availableVariants={params.has("no-off") ? ["low", "high"] : ["off", "low", "high"]} popoverLayer={document.getElementById("picker-layer")!} onChange={next => { setValue(next); setChanges(count => count + 1) }} /></header>
        <div class="composer">Composer</div>
        <output aria-label="Saved thinking">{value() || "provider-default"}</output>
        <output aria-label="Thinking changes">{changes()}</output>
      </I18nProvider>, document.querySelector("#root")!)
    `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwind()],
    resolve: {
      alias: [{ find: "@", replacement: source }],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid", "fuzzysort"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("thinking choices stay above the composer, distinguish Default from Off, and support keyboard dismissal", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 }, reducedMotion: "reduce" })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => console.error(error.message))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Select thinking effort: high", exact: true }).click({ timeout: 10000 })
    const listbox = page.getByRole("listbox", { name: "Select thinking effort", exact: true })
    await listbox.waitFor()
    expect(await page.locator("#picker-layer").getByRole("listbox").count()).toBe(1)
    expect(await listbox.getByRole("option").count()).toBe(4)
    const bounds = await page.getByRole("dialog").boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(256)
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
    expect(
      await page.getByRole("button", { name: "Select thinking effort: high", exact: true }).locator("svg").count(),
    ).toBe(1)
    await page.getByRole("option", { name: /^Off/ }).click()
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("off")
    const trigger = page.getByRole("button", { name: "Select thinking effort: Off", exact: true })
    await trigger.press("ArrowDown")
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option")
    await page.keyboard.press("Home")
    await page.keyboard.press("Enter")
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("provider-default")
    const defaultTrigger = page.getByRole("button", { name: "Select thinking effort: Default", exact: true })
    await defaultTrigger.press("Enter")
    await page.getByRole("option", { name: /^Default/ }).click()
    await listbox.waitFor({ state: "detached" })
    expect(await page.getByLabel("Thinking changes").textContent()).toBe("2")
    await defaultTrigger.press("Enter")
    await page.keyboard.press("Escape")
    await listbox.waitFor({ state: "detached" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Select thinking effort: Default",
      undefined,
      { timeout: 5000 },
    )
    expect(await defaultTrigger.getAttribute("aria-expanded")).toBe("false")
    expect(await defaultTrigger.evaluate((element) => document.activeElement === element)).toBe(true)
  } finally {
    await page.close()
  }
}, 30_000)

test("toolbar thinking shows only its value while retaining the accessible purpose", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  try {
    await page.goto(`${url}?toolbar`)
    const trigger = page.getByRole("button", { name: "Select thinking effort: high", exact: true })
    await trigger.waitFor()
    expect(await trigger.textContent()).toBe("high")
    expect(await trigger.locator("svg").count()).toBe(0)
    expect(await trigger.getAttribute("class")).toBe("stb-selector-btn")
    await trigger.hover()
    await page.getByRole("tooltip", { name: "Select thinking effort", exact: true }).waitFor()
    await trigger.press("Enter")
    await page.getByRole("tooltip").waitFor({ state: "detached" })
    await page.getByRole("option", { name: /^Off/ }).click()
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("off")
  } finally {
    await page.close()
  }
}, 30_000)

test("unknown saved thinking stays labeled and unsupported Off is not offered", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  try {
    await page.goto(`${url}?no-off&value=legacy-effort`)
    await page.getByRole("button", { name: "Select thinking effort: legacy-effort", exact: true }).click()
    const options = page.getByRole("option")
    await options.first().waitFor()
    expect(await options.count()).toBe(3)
    expect(await page.getByRole("option", { name: /^Off/ }).count()).toBe(0)
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(0)
    await page.getByRole("option", { name: /^Default/ }).click()
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("provider-default")
  } finally {
    await page.close()
  }
}, 30_000)

test("thinking options share unfilled selection and hover and keyboard feedback in both themes", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 }, reducedMotion: "reduce" })
  page.setDefaultTimeout(5000)
  try {
    await page.goto(`${url}?toolbar`)
    await page.getByRole("button", { name: "Select thinking effort: high", exact: true }).click()
    const high = page.getByRole("option", { name: /^high/ })
    const low = page.getByRole("option", { name: /^low/ })
    const colors: string[] = []
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await low.hover()
      expect(await high.getAttribute("aria-selected")).toBe("true")
      expect(await high.locator('[data-slot="menu-field-indicator"]').count()).toBe(1)
      expect(await high.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      expect(await low.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
      if (process.env.SYNERGY_VISUAL_OUTPUT) {
        await page.screenshot({ path: path.join(process.env.SYNERGY_VISUAL_OUTPUT, `thinking-${colorScheme}.png`) })
      }
      await page.keyboard.press("ArrowUp")
      expect(await page.getByRole("option", { name: /^Off/ }).getAttribute("data-highlighted")).toBe("")
      expect(await page.getByLabel("Saved thinking").textContent()).toBe("high")
      colors.push(await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).backgroundColor))
    }
    expect(colors[0]).not.toBe(colors[1])
  } finally {
    await page.close()
  }
}, 30_000)
