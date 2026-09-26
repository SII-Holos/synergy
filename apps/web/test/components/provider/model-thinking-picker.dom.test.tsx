import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".thinking-picker-fixture-"))
  const icons = path.join(directory, "icons.tsx")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(icons, "export const Icon = () => null; export const getSemanticIcon = value => value"),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { createSignal } from "solid-js"
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { ModelVariantPicker } from ${JSON.stringify(`/@fs/${source}/components/provider/model-thinking-picker.tsx`)}
      const core = setupI18n({ locale: "en", messages: { en: {} } })
      const [value, setValue] = createSignal("high")
      render(() => <I18nProvider i18n={core}>
        <style>{"body { margin: 0; } header { position: relative; z-index: 30; height: 40px; } .composer { position: relative; z-index: 40; height: 400px; background: white; } .z-70 { z-index: 70; width: 256px; max-width: calc(100vw - 32px); background: white; } [data-slot=list-item] { display: block; width: 100%; height: 44px; }"}</style>
        <header><ModelVariantPicker value={value()} availableVariants={["off", "low", "high"]} onChange={setValue} /></header>
        <div class="composer">Composer</div>
        <output aria-label="Saved thinking">{value() || "provider-default"}</output>
      </I18nProvider>, document.querySelector("#root")!)
    `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        { find: "@ericsanchezok/synergy-ui/icon", replacement: icons },
        { find: "@ericsanchezok/synergy-ui/semantic-icon", replacement: icons },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid", "fuzzysort"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
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
  const page = await browser.newPage({ viewport: { width: 375, height: 720 } })
  page.on("pageerror", (error) => console.error(error.message))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Select thinking effort: high", exact: true }).click({ timeout: 10000 })
    await page.getByRole("button", { name: /^Off/ }).click({ timeout: 5000 })
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("off")
    const trigger = page.getByRole("button", { name: "Select thinking effort: Off", exact: true })
    await trigger.press("Enter")
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")
    expect(await page.getByLabel("Saved thinking").textContent()).toBe("provider-default")
    const defaultTrigger = page.getByRole("button", { name: "Select thinking effort: Default", exact: true })
    await defaultTrigger.press("Enter")
    await page.keyboard.press("Escape")
    expect(await defaultTrigger.getAttribute("aria-expanded")).toBe("false")
    expect(await defaultTrigger.evaluate((element) => document.activeElement === element)).toBe(true)
  } finally {
    await page.close()
  }
}, 30_000)
