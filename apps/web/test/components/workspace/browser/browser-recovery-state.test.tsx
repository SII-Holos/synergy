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
let fixtureUrl: string

const appSource = path.resolve(import.meta.dir, "../../../..", "src")
const surfacePath = path.resolve(appSource, "components/workspace/browser/browser-surface.tsx")
const storePath = path.resolve(appSource, "components/workspace/browser/browser-store.tsx")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".browser-recovery-state-fixture-"))
  const platformStubPath = path.join(fixtureDirectory, "platform-stub.ts")
  const uiStubPath = path.join(fixtureDirectory, "ui-stub.tsx")
  const nativeSurfaceStubPath = path.join(fixtureDirectory, "native-surface-stub.tsx")
  const remoteSurfaceStubPath = path.join(fixtureDirectory, "remote-surface-stub.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      platformStubPath,
      `
        export const usePlatform = () => ({ browserNative: {} })
      `,
    ),
    Bun.write(
      uiStubPath,
      `
        export function Button(props: { children?: unknown; onClick?: () => void }) {
          return <button type="button" onClick={props.onClick}>{props.children}</button>
        }
        export function Icon() { return null }
        export function getSemanticIcon() { return "globe" }
      `,
    ),
    Bun.write(
      nativeSurfaceStubPath,
      `
        export function NativeBrowserSurface() {
          return <div data-testid="native-surface" />
        }
      `,
    ),
    Bun.write(
      remoteSurfaceStubPath,
      `
        export function RemoteBrowserSurface() {
          return <div data-testid="remote-surface" />
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { BrowserStoreProvider, createBrowserStore } from ${JSON.stringify(`/@fs/${storePath}`)}
        import { BrowserSurface } from ${JSON.stringify(`/@fs/${surfacePath}`)}
        import { browser as B } from "@/locales/messages"

        const pageState = {
          id: "page-1",
          title: "Example",
          url: "https://example.test",
          isLoading: false,
          lastActiveAt: null,
        }
        const store = createBrowserStore()
        store.setSession("page", pageState)
        store.setSession("connectionStatus", "connected")
        const nativePresentation = {
          protocolVersion: 2,
          kind: "native",
          capabilities: { native: true, webrtc: true },
          reason: "desktop-local",
        } as const

        store.setHostStatus(pageState.id, "restarting")

        const catalog = Object.fromEntries(Object.values(B).map((descriptor) => [descriptor.id, descriptor.message]))
        const i18n = setupI18n({ locale: "en" })
        i18n.loadAndActivate({ locale: "en", messages: catalog })
        const retryCalls: string[] = []

        ;(window as any).__browserRecovery = {
          setHostStatus: (status: string) => store.setHostStatus(pageState.id, status),
          setBrowserError: (error: unknown) => store.setBrowserError(error as any),
          clearBrowserError: () => store.setBrowserError(null),
          pageId: () => store.pageId(),
          setPresentation: (enabled: boolean) => store.setPresentation(enabled ? nativePresentation : null),

          retryCalls,
        }

        function App() {
          return createComponent(I18nProvider, {
            i18n,
            get children() {
              return createComponent(BrowserStoreProvider, {
                store,
                get children() {
                  return createComponent(BrowserSurface, {
                    sessionID: "session-1",
                    clientPresentation: "native",
                    ownerKey: "owner-1",
                    onRetryNative: () => retryCalls.push("retry"),
                  })
                },
              })
            },
          })
        }

        render(() => createComponent(App, {}), document.querySelector("#root")!)
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        { find: "@/context/platform", replacement: platformStubPath },
        { find: "@ericsanchezok/synergy-ui/button", replacement: uiStubPath },
        { find: "@ericsanchezok/synergy-ui/icon", replacement: uiStubPath },
        { find: "@ericsanchezok/synergy-ui/semantic-icon", replacement: uiStubPath },
        { find: "./native-browser-surface", replacement: nativeSurfaceStubPath },
        { find: "./remote-browser-surface", replacement: remoteSurfaceStubPath },
        { find: "@", replacement: appSource },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    cacheDir: path.join(fixtureDirectory, ".vite"),
    server: {
      host: "127.0.0.1",
      port: 5220,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../../../"), fixtureDirectory] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

  fixtureUrl = server.resolvedUrls?.local[0] ?? ""
  if (!fixtureUrl) throw new Error("Expected Vite test server URL")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(fixtureUrl)
  await page.waitForSelector(".browser-empty-title", { timeout: 30_000 })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Browser native recovery surface", () => {
  test("renders restarting, failed, and ready states while keeping the page and Retry reachable", async () => {
    expect(await page.locator(".browser-empty-title").textContent()).toBe("Recovering the native browser…")
    expect(await page.locator(".browser-empty-text").textContent()).toContain("Synergy will keep retrying")
    expect(await page.locator('[data-testid="native-surface"]').count()).toBe(0)
    expect(await page.locator('[data-testid="remote-surface"]').count()).toBe(0)
    expect(await page.evaluate(() => (window as any).__browserRecovery.pageId())).toBe("page-1")

    await page.evaluate(() => {
      const state = (window as any).__browserRecovery
      state.setPresentation(false)
      state.setHostStatus("failed")

      state.setBrowserError({
        severity: "error",
        message: "Native renderer stopped.",
      })
    })
    await expect(page.locator(".browser-empty-title").textContent()).resolves.toBe("Native browser recovery failed")
    expect(await page.locator(".browser-empty-text").textContent()).toContain("retry now")
    const retry = page.getByRole("button", { name: "Retry" })
    await expect(retry.count()).resolves.toBe(1)
    await retry.click()
    expect(await page.evaluate(() => (window as any).__browserRecovery.retryCalls)).toEqual(["retry"])
    expect(await page.evaluate(() => (window as any).__browserRecovery.pageId())).toBe("page-1")

    await page.evaluate(() => {
      const state = (window as any).__browserRecovery
      state.clearBrowserError()
      state.setPresentation(true)
      state.setHostStatus("ready")
    })
    await page.waitForSelector('[data-testid="native-surface"]', { state: "attached", timeout: 30_000 })
    expect(await page.locator(".browser-empty-state").count()).toBe(0)
    expect(await page.locator('[data-testid="native-surface"]').count()).toBe(1)
    expect(await page.locator('[data-testid="remote-surface"]').count()).toBe(0)
  })
})
