import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let baseUrl: string
let pageErrors: string[] = []

const bannerPath = path.resolve(import.meta.dir, "../../../src/components/app-shell/model-unavailable-banner.tsx")

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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".model-banner-fixture-"))
  const globalSyncStubPath = path.join(fixtureDirectory, "global-sync-stub.ts")
  const settingsStubPath = path.join(fixtureDirectory, "settings-stub.tsx")

  await Promise.all([
    // The app root resets the default body margin; match it so full-width
    // measurements describe the strip rather than the browser default.
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<style>html,body{margin:0;padding:0}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    // The banner reads the global provider snapshot. A real Solid store keeps
    // the fixture faithful to the app's reactivity so clearing is observable.
    Bun.write(
      globalSyncStubPath,
      `
        import { createStore } from "solid-js/store"

        export const EMPTY = ${JSON.stringify(EMPTY_SNAPSHOT)}

        const [state, setState] = createStore({ provider: EMPTY })
        globalThis.__setProvider = (provider) => setState("provider", provider ?? EMPTY)

        export function useGlobalSync() {
          return { data: state }
        }
      `,
    ),
    // SettingsDialog is replaced so the fixture can observe exactly what the
    // banner's action opens without booting the whole Settings surface. The
    // node carries visible content so Playwright can wait for it.
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
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from "@lingui/core"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { ModelUnavailableBanner } from ${JSON.stringify(`/@fs/${bannerPath}`)}
        import { AP } from "@/app-i18n"

        const messages = {}
        for (const descriptor of Object.values(AP)) {
          if (descriptor && typeof descriptor === "object" && "id" in descriptor && "message" in descriptor) {
            messages[descriptor.id] = descriptor.message
          }
        }
        const i18n = setupI18n({ locale: "en", messages: { en: messages } })

        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(ModelUnavailableBanner, {})
                  },
                })
              },
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
    cacheDir: path.join(fixtureDirectory, ".vite"),
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    resolve: {
      alias: [
        { find: "@/context/global-sync", replacement: globalSyncStubPath },
        { find: "@/components/settings", replacement: settingsStubPath },
        { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  baseUrl = url

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
  pageErrors = []
})

const banner = () => page.locator('[data-component="model-unavailable-banner"]')
const action = () => page.locator('[data-component="model-unavailable-banner"] button')
const settingsStub = () => page.locator('[data-component="settings-stub"]')

async function mount(snapshot: unknown) {
  await page.goto(baseUrl)
  await page.evaluate(
    (next) => (globalThis as unknown as { __setProvider(v: unknown): void }).__setProvider(next),
    snapshot,
  )
  return banner()
}

describe("model unavailable banner", () => {
  test("renders nothing when a usable model exists, including an env-only provider", async () => {
    await mount(USABLE_ENV_PROVIDER)
    await page.waitForTimeout(50)
    await expect(banner().count()).resolves.toBe(0)
  })

  test("shows the not-configured copy and connect action when nothing is connected", async () => {
    await mount(EMPTY_SNAPSHOT)
    await banner().waitFor()
    const text = await banner().innerText()
    expect(text).toContain("Connect a provider")
    expect(text).toContain("synergy config")
  })

  test("shows needs-attention copy without raw failure codes", async () => {
    await mount(NEEDS_ATTENTION)
    await banner().waitFor()
    const text = await banner().innerText()
    expect(text).toContain("needs attention before its models can run")
    expect(text).toContain("Review providers")
    expect(text).not.toContain("action_required")
    expect(text).not.toContain("authentication_required")
  })

  test("shows restricted copy for disabled and empty-catalog providers without raw reason codes", async () => {
    await mount(RESTRICTED_MANY)
    await banner().waitFor()
    const text = await banner().innerText()
    expect(text).toContain("No model is available to select")
    expect(text).not.toContain("disabled")
    expect(text).not.toContain("no_models")
  })

  test("distinguishes the three reasons with their own copy", async () => {
    const copy: string[] = []
    for (const snapshot of [EMPTY_SNAPSHOT, NEEDS_ATTENTION, RESTRICTED_MANY]) {
      await mount(snapshot)
      await banner().waitFor()
      copy.push((await banner().innerText()).replace("⚠", "").trim())
      await page.waitForTimeout(30)
    }
    expect(new Set(copy).size).toBe(3)
  })

  test("clears live when a usable provider appears, with no reload", async () => {
    await mount(EMPTY_SNAPSHOT)
    await banner().waitFor()
    const urlBefore = page.url()
    await page.evaluate(
      (next) => (globalThis as unknown as { __setProvider(v: unknown): void }).__setProvider(next),
      USABLE_ENV_PROVIDER,
    )
    await expect(banner().count()).resolves.toBe(0)
    expect(page.url()).toBe(urlBefore)
  })

  test("returns when the last usable provider stops being available", async () => {
    await mount(USABLE_ENV_PROVIDER)
    await page.waitForTimeout(50)
    await page.evaluate(
      (next) => (globalThis as unknown as { __setProvider(v: unknown): void }).__setProvider(next),
      NEEDS_ATTENTION,
    )
    await banner().waitFor()
    await expect(banner().count()).resolves.toBe(1)
  })

  test("opens Settings at the provider section and focuses the single affected provider", async () => {
    await mount(NEEDS_ATTENTION)
    await banner().waitFor()
    await action().click()
    await settingsStub().waitFor()
    expect(await settingsStub().getAttribute("data-tab")).toBe("providers")
    expect(await settingsStub().getAttribute("data-focus")).toBe("rejected")
  })

  test("opens Settings without focusing a provider when none is singled out", async () => {
    await mount(EMPTY_SNAPSHOT)
    await banner().waitFor()
    await action().click()
    await settingsStub().waitFor()
    expect(await settingsStub().getAttribute("data-tab")).toBe("providers")
    expect(await settingsStub().getAttribute("data-focus")).toBe("")
  })

  test("omits the focus target when several providers are affected", async () => {
    await mount(RESTRICTED_MANY)
    await banner().waitFor()
    await action().click()
    await settingsStub().waitFor()
    expect(await settingsStub().getAttribute("data-focus")).toBe("")
  })

  test("is announced politely and stays keyboard operable with a visible focus ring", async () => {
    await mount(NEEDS_ATTENTION)
    await banner().waitFor()
    expect(await banner().getAttribute("role")).toBe("status")
    expect(await banner().getAttribute("aria-live")).toBe("polite")
    await action().focus()
    expect(await action().evaluate((node) => node === document.activeElement)).toBe(true)
  })

  test("keeps the action reachable and the strip full width at 375 px", async () => {
    await page.setViewportSize({ width: 375, height: 640 })
    await mount(RESTRICTED_MANY)
    await banner().waitFor()
    const box = await banner().boundingBox()
    expect(box?.width).toBe(375)
    await expect(action().isVisible()).resolves.toBe(true)
    const actionBox = await action().boundingBox()
    expect(actionBox?.width).toBeGreaterThan(0)
    await page.setViewportSize({ width: 800, height: 600 })
  })
})
