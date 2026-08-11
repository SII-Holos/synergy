import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".boss-mode-panel-fixture-"))
  const panelPath = path.resolve(import.meta.dir, "../../../../src/components/settings/panels/BossModePanel.tsx")
  const typesPath = path.resolve(import.meta.dir, "../../../../src/components/settings/types.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { BossModePanel } from ${JSON.stringify(`/@fs/${panelPath}`)}
        import { defaultSettingsState } from ${JSON.stringify(`/@fs/${typesPath}`)}

        const i18n = setupI18n({ locale: "en" })
        function App() {
          const [runtime, setRuntime] = createSignal<Record<string, string>>({
            ...defaultSettingsState("enter").runtime,
            bossMode: "true",
            bossIdentityText: "Ops lead",
            bossBriefingIntervalDays: "7",
          })
          const [changes, setChanges] = createSignal<Array<[string, string]>>([])
          ;(window as any).__bossChanges = () => changes()
          return createComponent(BossModePanel, {
            get runtime() {
              return runtime()
            },
            onRuntimeChange: (key: string, value: string) => {
              setChanges((prev) => [...prev, [key, value]])
              setRuntime((prev) => ({ ...prev, [key]: value }))
            },
          })
        }

        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              children: () => createComponent(App),
            }),
          document.querySelector("#root"),
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("BossModePanel", () => {
  test("renders the switch and fields, reports changes, and hides the interval when disabled", async () => {
    // The whole contract runs as one browser session: bun test reaps the
    // Playwright browser between tests, so a single sequential test keeps
    // the page alive (same pattern as packages/app menu-field.test.ts).

    // 1. Enabled state renders the switch, identity textarea, and briefing interval.
    const switchInput = page.locator('[data-slot="switch-input"]')
    await expect(switchInput.count()).resolves.toBe(1)
    expect(await switchInput.getAttribute("aria-checked")).toBe("true")

    const identity = page.locator('textarea[data-slot="input-input"]')
    await expect(identity.count()).resolves.toBe(1)
    expect(await identity.inputValue()).toBe("Ops lead")
    expect(await identity.isDisabled()).toBe(false)

    const interval = page.locator('input[data-slot="input-input"][type="number"]')
    await expect(interval.count()).resolves.toBe(1)
    expect(await interval.inputValue()).toBe("7")

    // 2. Toggling the switch off reports bossMode and hides the interval.
    await page.locator('[data-slot="switch-control"]').dispatchEvent("click")
    expect(
      await page.evaluate(() =>
        (window as unknown as { __bossChanges: () => Array<[string, string]> }).__bossChanges(),
      ),
    ).toEqual([["bossMode", "false"]])
    await expect(interval.count()).resolves.toBe(0)
    expect(await identity.isDisabled()).toBe(true)

    // 3. Re-enabling restores the interval; edits flow through onRuntimeChange.
    await page.locator('[data-slot="switch-control"]').dispatchEvent("click")
    await expect(interval.count()).resolves.toBe(1)
    await identity.fill("ops lead")
    await interval.fill("5")
    expect(
      await page.evaluate(() =>
        (window as unknown as { __bossChanges: () => Array<[string, string]> }).__bossChanges(),
      ),
    ).toEqual([
      ["bossMode", "false"],
      ["bossMode", "true"],
      ["bossIdentityText", "ops lead"],
      ["bossBriefingIntervalDays", "5"],
    ])
  })
})
