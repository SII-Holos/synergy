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
  const stubPath = path.join(fixtureDirectory, "stubs.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    // The panel's module graph reaches ui toast, the global SDK context, and
    // error helpers that pull heavy runtime modules; route them to a hermetic
    // stub so the fixture exercises the panel without the SDK provider stack.
    Bun.write(
      stubPath,
      `
        export const showToast = () => 0
        export const requestErrorMessage = (error: unknown, fallback = "Request failed") =>
          error instanceof Error ? error.message : fallback
        export const useGlobalSDK = (): never => {
          throw new Error("GlobalSDK context is not mounted in this fixture")
        }
      `,
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

        // In-memory self-memory store backing the injected boss name gateway.
        const rows: Array<Record<string, string>> = []
        const libraryCalls: Array<Record<string, unknown>> = []
        const listSelfMemories = async () => [...rows]
        const createMemory = async (input: Record<string, string>) => {
          libraryCalls.push({ kind: "create", ...input })
          rows.push({ id: "mem_" + String(rows.length + 1), ...input })
        }
        const updateMemory = async (input: Record<string, string>) => {
          libraryCalls.push({ kind: "update", ...input })
          const row = rows.find((candidate) => candidate.id === input.id)
          if (row) Object.assign(row, input)
        }

        function App() {
          const [runtime, setRuntime] = createSignal<Record<string, string>>({
            ...defaultSettingsState("enter").runtime,
            bossMode: "true",
          })
          const [changes, setChanges] = createSignal<Array<[string, string]>>([])
          ;(window as any).__bossChanges = () => changes()
          ;(window as any).__bossLibraryCalls = () => libraryCalls
          return createComponent(BossModePanel, {
            get runtime() {
              return runtime()
            },
            onRuntimeChange: (key: string, value: string) => {
              setChanges((prev) => [...prev, [key, value]])
              setRuntime((prev) => ({ ...prev, [key]: value }))
            },
            get bossNameGateway() {
              return { listSelfMemories, createMemory, updateMemory }
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
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: stubPath },
        { find: "@/utils/error", replacement: stubPath },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: stubPath },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5203,
      strictPort: true,
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

async function bossChanges(): Promise<Array<[string, string]>> {
  return page.evaluate(() => (window as unknown as { __bossChanges: () => Array<[string, string]> }).__bossChanges())
}

async function bossLibraryCalls(): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window as unknown as { __bossLibraryCalls: () => Array<Record<string, unknown>> }).__bossLibraryCalls(),
  )
}

describe("BossModePanel", () => {
  test("switches personality, custom traits, and persists the boss name through the library", async () => {
    // The whole contract runs as one browser session: bun test reaps the
    // Playwright browser between tests, so a single sequential test keeps
    // the page alive (same pattern as packages/app menu-field.test.ts).

    // 1. Enabled state renders the switch, personality pills, and name field;
    //    the legacy identity textarea and briefing interval are gone.
    const switchInput = page.locator('[data-slot="switch-input"]')
    await expect(switchInput.count()).resolves.toBe(1)
    expect(await switchInput.getAttribute("aria-checked")).toBe("true")

    const personality = page.locator('[role="group"][aria-label="Personality"]')
    await expect(personality.count()).resolves.toBe(1)
    expect(await personality.locator("button").count()).toBe(4)

    const nameInput = page.locator('input[data-slot="input-input"]')
    await expect(nameInput.count()).resolves.toBe(1)
    expect(await nameInput.inputValue()).toBe("")
    expect(await nameInput.isDisabled()).toBe(false)

    expect(await page.locator('textarea[data-slot="input-input"]').count()).toBe(0)
    expect(await page.locator('input[data-slot="input-input"][type="number"]').count()).toBe(0)
    expect(await page.locator('input[type="range"]').count()).toBe(0)

    // 2. Choosing a built-in preset reports bossPersonaPreset and shows no sliders.
    await page.getByRole("button", { name: "Project Manager" }).click()
    expect(await bossChanges()).toEqual([["bossPersonaPreset", "project_manager"]])
    expect(await page.locator('input[type="range"]').count()).toBe(0)

    // 3. Custom reveals the four trait sliders; moving one reports the value.
    await page.getByRole("button", { name: "Custom" }).click()
    expect(await bossChanges()).toEqual([
      ["bossPersonaPreset", "project_manager"],
      ["bossPersonaPreset", "custom"],
    ])
    const sliders = page.locator('input[type="range"]')
    await expect(sliders.count()).resolves.toBe(4)
    await page.getByRole("slider", { name: "Formality" }).evaluate((element: HTMLInputElement) => {
      element.value = "0.75"
      element.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(await bossChanges()).toEqual([
      ["bossPersonaPreset", "project_manager"],
      ["bossPersonaPreset", "custom"],
      ["bossPersonaFormality", "0.75"],
    ])

    // 4. Typing a name reports bossName and debounce-persists via the library
    //    gateway (create first, then update for a second edit).
    await nameInput.fill("Xiaofei")
    expect((await bossChanges()).at(-1)).toEqual(["bossName", "Xiaofei"])
    await page.waitForTimeout(900)
    let calls = await bossLibraryCalls()
    expect(calls).toEqual([
      {
        kind: "create",
        title: "boss_name",
        content: "Xiaofei",
        category: "self",
        recallMode: "search_only",
      },
    ])

    await nameInput.fill("Xiaofei Chen")
    await page.waitForTimeout(900)
    calls = await bossLibraryCalls()
    expect(calls).toEqual([
      {
        kind: "create",
        title: "boss_name",
        content: "Xiaofei",
        category: "self",
        recallMode: "search_only",
      },
      {
        kind: "update",
        id: "mem_1",
        title: "boss_name",
        content: "Xiaofei Chen",
        category: "self",
        recallMode: "search_only",
      },
    ])

    // 5. Disabling boss mode keeps the name field present but disabled and
    //    leaves the personality row reachable (no legacy rows return).
    await page.locator('[data-slot="switch-control"]').dispatchEvent("click")
    expect(await bossChanges()).toContainEqual(["bossMode", "false"])
    expect(await nameInput.isDisabled()).toBe(true)
    expect(await page.locator('input[type="range"]').count()).toBe(4)
    expect(await page.locator('textarea[data-slot="input-input"]').count()).toBe(0)
    expect(await page.locator('input[data-slot="input-input"][type="number"]').count()).toBe(0)
  })
})
