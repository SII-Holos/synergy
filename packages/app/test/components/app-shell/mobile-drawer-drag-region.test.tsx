import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let server: ViteDevServer
let fixtureDirectory: string
let fixtureUrl: string

const stubModules: Record<string, string> = {
  "stub-layout.ts": `
    import { createSignal } from "solid-js"

    const [mobileOpened, setMobileOpened] = createSignal(true)
    const [rightOpened, setRightOpened] = createSignal(false)

    export const SESSION_PAGE_SIZE = 20

    export function useLayout() {
      return {
        mobileSidebar: {
          opened: mobileOpened,
          hide: () => setMobileOpened(false),
          show: () => setMobileOpened(true),
          toggle: () => setMobileOpened((value) => !value),
        },
        rightSidebar: {
          opened: rightOpened,
          hide: () => setRightOpened(false),
          show: () => setRightOpened(true),
          toggle: () => setRightOpened((value) => !value),
        },
        scopes: { list: () => [], open: async () => {} },
        nav: {
          recentEntries: () => [],
          hasMoreRecent: () => false,
          loadMoreNav: async () => {},
          archiveSession: async () => null,
          projectSessions: () => [],
          childStoreForScope: () => undefined,
          pinSession: () => {},
        },
        isDesktop: () => true,
      }
    }

    if (typeof window !== "undefined") {
      ;(window as any).__drawerControl = {
        openMobile: () => setMobileOpened(true),
        openRight: () => setRightOpened(true),
      }
    }
  `,
  "stub-notification.ts": `
    export function useNotification() {
      return { session: { unseen: () => [] } }
    }
  `,
  "stub-global-sync.ts": `
    export function useGlobalSync() {
      return { data: { scope: [], paths: undefined } }
    }
  `,
  "stub-global-sdk.ts": `
    export function useGlobalSDK() {
      return { url: "", client: {}, connected: () => true }
    }
  `,
  "stub-workbench.ts": `
    export function useWorkbenchPanels() {
      return {
        surface: () => ({ opened: () => false, activeTab: () => undefined }),
        openPanel: async () => {},
      }
    }
  `,
  "stub-theme.ts": `
    export function useTheme() {
      return { mode: () => "light" }
    }
  `,
  "stub-dialog.ts": `
    export function useDialog() {
      return { show: () => {} }
    }
  `,
  "stub-confirm.ts": `
    export function useConfirm() {
      return { show: () => {} }
    }
  `,
  "stub-settings.ts": `
    export function SettingsDialog() {
      return null
    }
  `,
  "stub-project-picker.ts": `
    export function useProjectDirectoryPicker() {
      return { pickProjectDirectories: async () => null }
    }
  `,
  "stub-sdk.ts": `
    export function createSynergyClient() {
      return { session: { list: async () => ({ data: { data: [], total: 0 } }) } }
    }
  `,
  "stub-scope-components.ts": `
    export function ActiveZone() {
      return null
    }
    export function SessionRow() {
      return null
    }
    export function PaginationBar() {
      return null
    }
  `,
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".mobile-drawer-drag-fixture-"))
  const appSrc = path.resolve(import.meta.dir, "../../../src")
  const navDrawerPath = path.join(appSrc, "components/app-shell/mobile-drawer.tsx")
  const toolsDrawerPath = path.join(appSrc, "components/app-shell/mobile-tools-drawer.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      `
        <div id="app"></div>
        <style>#app button { min-width: 2rem; min-height: 2rem; }</style>
        <script type="module" src="/main.tsx"></script>
      `,
    ),
    ...Object.entries(stubModules).map(([name, source]) => Bun.write(path.join(fixtureDirectory, name), source)),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { Router, Route } from "@solidjs/router"
        import { i18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { MobileDrawer } from ${JSON.stringify(`/@fs/${navDrawerPath}`)}
        import { MobileToolsDrawer } from ${JSON.stringify(`/@fs/${toolsDrawerPath}`)}

        i18n.load("en", {})
        i18n.activate("en")

        render(
          () => (
            <I18nProvider i18n={i18n}>
              <Router>
                <Route path="*" component={() => (
                  <>
                    <MobileDrawer />
                    <MobileToolsDrawer />
                  </>
                )} />
              </Router>
            </I18nProvider>
          ),
          document.getElementById("app")!,
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
        { find: "@/context/layout", replacement: path.join(fixtureDirectory, "stub-layout.ts") },
        { find: "@/context/notification", replacement: path.join(fixtureDirectory, "stub-notification.ts") },
        { find: "@/context/global-sync", replacement: path.join(fixtureDirectory, "stub-global-sync.ts") },
        { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "stub-global-sdk.ts") },
        { find: "@/context/workbench", replacement: path.join(fixtureDirectory, "stub-workbench.ts") },
        { find: "@/components/settings", replacement: path.join(fixtureDirectory, "stub-settings.ts") },
        {
          find: "@/components/dialog/project-directory-picker",
          replacement: path.join(fixtureDirectory, "stub-project-picker.ts"),
        },
        { find: "@/components/dialog/confirm-dialog", replacement: path.join(fixtureDirectory, "stub-confirm.ts") },
        {
          find: "@/components/scopes/active-zone",
          replacement: path.join(fixtureDirectory, "stub-scope-components.ts"),
        },
        {
          find: "@/components/scopes/session-row",
          replacement: path.join(fixtureDirectory, "stub-scope-components.ts"),
        },
        {
          find: "@/components/scopes/pagination-bar",
          replacement: path.join(fixtureDirectory, "stub-scope-components.ts"),
        },
        { find: "@ericsanchezok/synergy-ui/theme", replacement: path.join(fixtureDirectory, "stub-theme.ts") },
        {
          find: "@ericsanchezok/synergy-ui/context/dialog",
          replacement: path.join(fixtureDirectory, "stub-dialog.ts"),
        },
        { find: "@ericsanchezok/synergy-sdk/client", replacement: path.join(fixtureDirectory, "stub-sdk.ts") },
        { find: "@/", replacement: `${appSrc}/` },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5215,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  fixtureUrl = server.resolvedUrls?.local[0] ?? ""
  if (!fixtureUrl) throw new Error("Expected Vite test server URL")
  browser = await chromium.launch({ headless: true })

  const warmup = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const warmupErrors: string[] = []
  warmup.on("pageerror", (error) => warmupErrors.push(String(error)))
  try {
    await warmup.goto(fixtureUrl)
    await warmup.waitForSelector(".mobile-drawer-header", { timeout: 60_000 })
    expect(warmupErrors, `fixture page errors: ${warmupErrors.join(" | ")}`).toEqual([])
  } finally {
    await warmup.close()
  }
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

async function withFixture(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  try {
    await page.goto(fixtureUrl)
    await page.waitForSelector(".mobile-drawer-header", { timeout: 20_000 })
    expect(pageErrors, `fixture page errors: ${pageErrors.join(" | ")}`).toEqual([])
    await run(page)
    expect(pageErrors, `fixture page errors: ${pageErrors.join(" | ")}`).toEqual([])
  } finally {
    await page.close()
  }
}

describe("mobile drawer drag-region exemption", () => {
  test("exempts both drawer header rows from the window drag region", async () => {
    await withFixture(async (page) => {
      await page.evaluate(() => (window as any).__drawerControl.openRight())
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-header").length === 2)

      const regions = await page
        .locator(".mobile-drawer-header")
        .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).getPropertyValue("-webkit-app-region")))
      expect(regions).toEqual(["no-drag", "no-drag"])
    })
  }, 30_000)

  test("close buttons still dismiss the drawers", async () => {
    await withFixture(async (page) => {
      await page.getByRole("button", { name: "Close navigation" }).click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-header").length === 0)

      await page.evaluate(() => (window as any).__drawerControl.openRight())
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-header").length === 1)
      await page.locator(".mobile-drawer-header button").click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-header").length === 0)
    })
  }, 30_000)
})
