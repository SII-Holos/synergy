import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
let fixtureDirectory: string
let baseUrl: string
let pageErrors: string[] = []

const selectorPath = path.resolve(import.meta.dir, "../../../src/components/dialog/dialog-select-model.tsx")

const EMPTY_SNAPSHOT = {
  all: [],
  default: {},
  connected: [],
  configProviders: [],
  catalogProviders: [],
  profiles: {},
  connections: {},
  authHealth: {},
  runtimeAvailability: {},
  modelCatalog: {},
}

const USABLE_ENV_PROVIDER = {
  ...EMPTY_SNAPSHOT,
  connected: ["env-only"],
  authHealth: { "env-only": { providerID: "env-only", status: "connected", source: "env" } },
  runtimeAvailability: {
    "env-only": { providerID: "env-only", available: true, reason: "connected", modelCount: 4 },
  },
}

const NEEDS_ATTENTION = {
  ...EMPTY_SNAPSHOT,
  connected: ["rejected"],
  authHealth: { rejected: { providerID: "rejected", status: "action_required", recovery: "reconnect" } },
  runtimeAvailability: {
    rejected: { providerID: "rejected", available: false, reason: "authentication_required", modelCount: 12 },
  },
}

const RESTRICTED_MANY = {
  ...EMPTY_SNAPSHOT,
  connected: ["alpha", "beta"],
  authHealth: {
    alpha: { providerID: "alpha", status: "connected" },
    beta: { providerID: "beta", status: "connected" },
  },
  runtimeAvailability: {
    alpha: { providerID: "alpha", available: false, reason: "disabled", modelCount: 3 },
    beta: { providerID: "beta", available: false, reason: "no_models", modelCount: 0 },
  },
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".model-availability-fixture-"))
  const globalSyncStubPath = path.join(fixtureDirectory, "global-sync-stub.ts")
  const settingsStubPath = path.join(fixtureDirectory, "settings-stub.tsx")
  const modelsStubPath = path.join(fixtureDirectory, "models-stub.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<style>html,body{margin:0;padding:0}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      globalSyncStubPath,
      `
        import { createStore } from "solid-js/store"

        export const EMPTY = ${JSON.stringify(EMPTY_SNAPSHOT)}

        const [state, setState] = createStore({ provider: EMPTY, scope: { status: "loading", provider: EMPTY }, route: {} })
        globalThis.__setProvider = (provider) => setState("provider", provider ?? EMPTY)
        globalThis.__setScope = (provider, status = "complete") => {
          setState("scope", { provider, status }); setState("route", {dir: btoa("project-scope")})
        }
        export const useParams = () => state.route

        export function useGlobalSync() {
          return { data: state, ensureScopeState: () => [state.scope] }
        }
      `,
    ),
    Bun.write(
      modelsStubPath,
      `export const QuickSwitcherList = props => <button onClick={props.onSelect}>Fixture model</button>`,
    ),
    Bun.write(
      settingsStubPath,
      `
        export function SettingsDialog(props) {
          return (
            <div
              data-component="settings-stub"
              data-tab={props.initialTab ?? ""}
              data-focus={props.providerFocusID ?? ""}
            >
              <span>providers settings</span>
            </div>
          )
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, Show } from "solid-js"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from "@lingui/core"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { ModelSelectorPopover, DialogSelectModel } from ${JSON.stringify(`/@fs/${selectorPath}`)}
        import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
        import { AP } from "@/app-i18n"
        import "@ericsanchezok/synergy-ui/styles"
        import "@/index.css"
        import "@/components/top-bar/session-top-bar.css"

        const messages = {}
        for (const descriptor of Object.values(AP)) {
          if (descriptor && typeof descriptor === "object" && "id" in descriptor && "message" in descriptor) {
            messages[descriptor.id] = descriptor.message
          }
        }
        const i18n = setupI18n({ locale: "en", messages: { en: messages } })

        const Shortcut = () => { const dialog = useDialog(); return <button onClick={() => dialog.show(() => <DialogSelectModel />)}>Model shortcut</button> }
        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return <div style="height:100dvh;display:flex;flex-direction:column">
                      <header class="stb-root" style="position:relative;pointer-events:auto;height:48px;flex-shrink:0;display:flex;align-items:center">
                        <ModelSelectorPopover placement="bottom-start" triggerAs={props => <button {...props} data-model-trigger class="stb-selector-btn">
                          <Show when={props.children} fallback={<span class="stb-selector-label">Fixture model</span>}>{props.children}</Show>
                        </button>} />
                        <Shortcut />
                      </header>
                      <main data-reading style="flex:1;min-height:0;overflow:auto">
                        <div style="height:1500px">Saved conversation</div>
                      </main>
                      <textarea aria-label="Message" style="height:120px;flex-shrink:0" />
                    </div>
                  },
                })
              },
            }),
          document.querySelector("#root"),
        )
      `,
    ),
  ])

  server = await createBrowserFixture({
    root: fixtureDirectory,
    styled: true,
    aliases: [
      { find: "@/context/global-sync", replacement: globalSyncStubPath },
      { find: "@/context/session-route", replacement: globalSyncStubPath },
      { find: "@/components/settings", replacement: settingsStubPath },
      { find: "@/components/provider/model-manager", replacement: modelsStubPath },
      { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
    ],
  })
  baseUrl = server.url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text())
  })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

afterEach(() => {
  if (pageErrors.length) console.error("PAGE ERRORS:", pageErrors.join("\n---\n"))
  expect(pageErrors).toEqual([])
  pageErrors = []
})

const notice = () => page.locator('[data-component="model-unavailable-notice"]')
const action = () => notice().getByRole("button")
const trigger = () => page.locator("[data-model-trigger]")
const settingsStub = () => page.locator('[data-component="settings-stub"]')

async function setProvider(snapshot: unknown) {
  await page.evaluate(
    (next) => (globalThis as unknown as { __setProvider(v: unknown): void }).__setProvider(next),
    snapshot,
  )
}

async function mount(snapshot: unknown) {
  await page.goto(baseUrl)
  await trigger().waitFor()
  await setProvider(snapshot)
}

describe("model availability recovery", () => {
  test("provider availability never shifts the page or its reading position", async () => {
    await mount(USABLE_ENV_PROVIDER)
    await trigger().focus()
    const original = await trigger().elementHandle()
    const before = await page.locator("[data-reading]").evaluate((node) => {
      node.scrollTop = 400
      return { top: node.getBoundingClientRect().top, height: node.clientHeight, scroll: node.scrollTop }
    })
    for (const snapshot of [EMPTY_SNAPSHOT, NEEDS_ATTENTION, RESTRICTED_MANY, USABLE_ENV_PROVIDER]) {
      await setProvider(snapshot)
      const frames = await page.locator("[data-reading]").evaluate(async (node) => {
        const result = []
        for (let i = 0; i < 8; i++) {
          await new Promise(requestAnimationFrame)
          result.push({ top: node.getBoundingClientRect().top, height: node.clientHeight, scroll: node.scrollTop })
        }
        return result
      })
      for (const frame of frames) expect(frame).toEqual(before)
      expect(await original!.evaluate((node) => node === document.activeElement)).toBe(true)
      expect(await notice().count()).toBe(0)
    }
  })

  test("usable models keep the normal selector, including env-only providers", async () => {
    await mount(USABLE_ENV_PROVIDER)
    expect(await trigger().innerText()).toBe("Fixture model")
    await trigger().click()
    await page.getByRole("button", { name: "Fixture model", exact: true }).last().click()
    expect(await trigger().getAttribute("aria-expanded")).toBe("false")
    expect(await notice().count()).toBe(0)
  })

  test("shows concise configuration guidance only after opening the model entry", async () => {
    await mount(EMPTY_SNAPSHOT)
    expect(await trigger().innerText()).toBe("Configure model")
    expect(await notice().count()).toBe(0)
    await trigger().click()
    expect(await notice().innerText()).toContain("Connect a provider to start a conversation")
    expect(await action().innerText()).toBe("Connect a provider")
    expect(await notice().innerText()).not.toContain("synergy config")
  })

  test("distinguishes authentication and catalog failures without raw failure codes", async () => {
    for (const [snapshot, label, explanation] of [
      [NEEDS_ATTENTION, "Check model connection", "connection or usage limits"],
      [RESTRICTED_MANY, "No models available", "Enable a provider"],
    ] as const) {
      await mount(snapshot)
      expect(await trigger().innerText()).toBe(label)
      await trigger().click()
      const text = await notice().innerText()
      expect(text).toContain(explanation)
      expect(text).not.toContain("action_required")
      expect(text).not.toContain("authentication_required")
      expect(text).not.toContain("no_models")
    }
  })

  test("recovers live without reopening the selector or reloading the page", async () => {
    await mount(EMPTY_SNAPSHOT)
    await trigger().click()
    await notice().waitFor()
    const url = page.url()
    const original = await trigger().elementHandle()
    await setProvider(USABLE_ENV_PROVIDER)
    expect(await notice().count()).toBe(0)
    expect(await trigger().innerText()).toBe("Fixture model")
    expect(await trigger().getAttribute("aria-expanded")).toBe("true")
    await setProvider(NEEDS_ATTENTION)
    await notice().waitFor()
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    expect(page.url()).toBe(url)
  })

  test("uses the current project's readiness and never mistakes its loading snapshot for missing configuration", async () => {
    await mount(EMPTY_SNAPSHOT)
    for (const [snapshot, status, label] of [
      [EMPTY_SNAPSHOT, "loading", "Fixture model"],
      [USABLE_ENV_PROVIDER, "complete", "Fixture model"],
      [NEEDS_ATTENTION, "partial", "Check model connection"],
    ] as const) {
      await page.evaluate(
        ({ snapshot, status }) =>
          (globalThis as unknown as { __setScope(v: unknown, status: string): void }).__setScope(snapshot, status),
        { snapshot, status },
      )
      expect(await trigger().innerText()).toBe(label)
    }
    await setProvider(USABLE_ENV_PROVIDER)
    expect(await trigger().innerText()).toBe("Check model connection")
  })

  test("opens provider Settings and focuses only a single affected provider", async () => {
    for (const [snapshot, focus] of [
      [EMPTY_SNAPSHOT, ""],
      [NEEDS_ATTENTION, "rejected"],
      [RESTRICTED_MANY, ""],
    ] as const) {
      await mount(snapshot)
      await trigger().click()
      await action().click()
      await settingsStub().waitFor()
      expect(await settingsStub().getAttribute("data-tab")).toBe("providers")
      expect(await settingsStub().getAttribute("data-focus")).toBe(focus)
      expect(await trigger().getAttribute("aria-expanded")).toBe("false")
    }
  })

  test("keyboard model shortcut also provides recovery instead of an empty list", async () => {
    await mount(NEEDS_ATTENTION)
    await page.getByRole("button", { name: "Model shortcut" }).click()
    await notice().waitFor()
    await action().click()
    await settingsStub().waitFor()
    expect(await settingsStub().getAttribute("data-focus")).toBe("rejected")
  })

  test("keeps recovery and focus reachable at narrow widths in both themes", async () => {
    for (const [width, theme] of [
      [375, "light"],
      [800, "dark"],
    ] as const) {
      await page.setViewportSize({ width, height: 640 })
      await mount(RESTRICTED_MANY)
      await page.evaluate((theme) => (document.documentElement.dataset.colorScheme = theme), theme)
      await trigger().focus()
      await page.keyboard.press("Enter")
      await notice().waitFor()
      expect(await notice().getByRole("status").getAttribute("aria-live")).toBe("polite")
      const box = (await action().boundingBox())!
      expect(box.width).toBeGreaterThan(0)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-model-trigger"))
      expect(await trigger().getAttribute("aria-expanded")).toBe("false")
    }
    await page.setViewportSize({ width: 800, height: 600 })
  })
})
