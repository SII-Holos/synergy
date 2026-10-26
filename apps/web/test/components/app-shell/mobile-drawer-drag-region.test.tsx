import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

let browser: Browser
let server: BrowserFixture
let fixtureDirectory: string
let fixtureUrl: string

const stubModules: Record<string, string> = {
  "stub-layout.ts": `
    import { createSignal } from "solid-js"

    const [mobileOpened, setMobileOpened] = createSignal(false)
    const [recentEntries, setRecentEntries] = createSignal([])
    const [scopes, setScopes] = createSignal([
      { id: "scp_fixture", worktree: "/tmp/fixture-project", name: "Fixture Project", expanded: false },
    ])

    export const SESSION_PAGE_SIZE = 20

    export function useLayout() {
      return {
        mobileSidebar: {
          opened: mobileOpened,
          hide: () => setMobileOpened(false),
          show: () => setMobileOpened(true),
          toggle: () => setMobileOpened((value) => !value),
        },
        scopes: {
          list: scopes,
          open: async () => {},
        },
        nav: {
          recentEntries,
          rootNavEntries: () => [],
          projectNavEntries: () => [],
          hasMoreRecent: () => recentEntries().length > 0,
          loadMoreNav: async () => {},
          archiveSession: async () => null,
          projectSessions: () => [],
          pinSession: () => {},
        },
        isDesktop: () => true,
      }
    }

    if (typeof window !== "undefined") {
      window.__drawerControl = {
        openMobile: () => setMobileOpened(true),
        closeMobile: () => setMobileOpened(false),
        populateCollections: () => {
          setRecentEntries(Array.from({ length: 40 }, (_, index) => ({
            id: "ses_long_" + index, scopeID: "home", scopeType: "home", category: "home",
            title: "Session " + index + " — " + "Long remote session title ".repeat(12),
            lastActivityAt: Date.now(), pinned: 0, archived: false,
            completionNotice: { unread: false, unreadCount: 0 },
          })))
          setScopes(Array.from({ length: 30 }, (_, index) => ({
            id: "scp_long_" + index, worktree: "/tmp/project-" + index,
            name: "Project " + index + " — " + "Long project name ".repeat(12), expanded: false,
          })))
        },
      }
    }
  `,
  "stub-platform.ts": `
    export function usePlatform() {
      return {
        platform: "desktop",
        openLink: url => { window.openedLink = url },
        desktopWindow: {
          chrome: "custom",
          minimize: async () => {},
          toggleMaximize: async () => null,
          close: async () => {},
          state: async () => null,
          onEvent: () => () => {},
        },
      }
    }
  `,
  "stub-notification.ts": `
    export function useNotification() {
      return { session: { unseen: () => [] } }
    }
  `,
  "stub-global-sync.ts": `
    export const FIXTURE_SESSION_STATUS = {
      ses_busy: { type: "busy" },
      ses_retry: { type: "retry", rootID: "retry-root", messageID: "retry-message", phase: "waiting", error: "rate limited", startedAt: 0, canRetry: true, attempt: 1, message: "rate limited", next: 1000 },
      ses_paused: { type: "paused", reason: "aborted", since: 1 },
      ses_idle: { type: "idle" },
    }

    export function useGlobalSync() {
      return {
        data: { scope: [], paths: undefined },
        sessionStatus: FIXTURE_SESSION_STATUS,
        permissions: {},
        questions: {},
        cortex: [],
      }
    }
  `,
  "stub-global-sdk.ts": `
    import { createSignal } from "solid-js"
    export const [features, setFeatures] = createSignal(["workbench", "agenda", "library", "plugin-host", "note", "browser", "kanban"])
    window.setFeatures = setFeatures
    export function useGlobalSDK() {
      return { capabilities: { has: id => features()?.includes(id) ?? false }, drafts: { hasDraftSession: () => false }, url: "", client: {}, connected: () => true }
    }
  `,
  "stub-workbench.ts": `
    import { createSignal } from "solid-js"
    import { features } from "./stub-global-sdk"
    const [native, setNative] = createSignal(true)
    window.setNative = setNative
    window.openedPanels = []
    export function useWorkbenchPanels() {
      return {
        surface: () => ({ opened: () => false, activeTab: () => undefined, toggle: () => {} }),
        openPanel: async (id) => { window.openedPanels.push(id) },
        getPanel: (id) => (id === "notes" ? features()?.includes("note") : native() && features()?.includes("browser")) ? { id } : undefined,
      }
    }
  `,
  "stub-confirm.ts": `
    export function useConfirm() {
      return { show: () => {} }
    }
  `,
  "stub-settings.tsx": `
    import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
    export function SettingsDialog(props) {
      return <Dialog title="Settings fixture"><h2>{props.initialTab === "providers" ? "Providers" : "General"}</h2><button>Settings action</button></Dialog>
    }
  `,
  "stub-topbar-services.ts": `
    import { useLingui } from "@lingui/solid"
    export const useLocale = () => ({ i18n: useLingui().i18n() })
    export const useLocal = () => ({ agent: { current: () => ({}) }, model: {
      current: () => ({ name: "A very long model name with a provider and reasoning version that must truncate" }),
      variant: { list: () => ["high"], displayed: () => undefined, set() {} },
      selection: { saving: () => false, state: () => undefined, error: () => undefined, retry() {} }
    } })
    export const useCommand = () => ({ options: [], keybind: () => undefined, trigger() {} })
    export const useSync = () => ({ session: { get: () => undefined } })
    export const useSessionDataView = () => () => ({ statusFor: () => ({ type: "idle" }), messagesFor: () => [] })
  `,
  "stub-topbar-components.tsx": `
    export const DialogSessionRename = () => null
    export const DialogSessionExport = () => null
    export const DialogSessionImport = () => null
    export const DialogSessionTransfer = () => null
    export const transferCopy = { title: { id: "fixture.transfer", message: "Transfer" } }
    export const WorktreeEnterConfirmDialog = () => null
    export const ModelSelectorPopover = props => props.triggerAs({ "aria-label": "Choose model" })
    export const ModelVariantPicker = () => null
    export const SessionTaskDetails = () => <><button class="stb-selector-btn" aria-label="Trajectory">T</button><button class="stb-icon-btn" aria-label="Task details">D</button></>
    export const SessionTagMenu = () => null
    export const SlotOutlet = () => null
    export const useConfirm = () => ({ show() {} })
  `,
  "stub-project-picker.ts": `
    export function useProjectDirectoryPicker() {
      return { pickProjectDirectories: async () => null }
    }
  `,
  "stub-sdk.ts": `
    import { FIXTURE_SESSION_STATUS } from "./stub-global-sync.ts"

    // ses_missing is listed without a runtime status entry: the row sees an
    // unknown status, which must not read as work in progress.
    const sessionIDs = [...Object.keys(FIXTURE_SESSION_STATUS), "ses_missing"]

    export function createSynergyClient() {
      return {
        session: {
          list: async () => ({
            data: {
              data: sessionIDs.map((id, index) => ({ id, title: id, time: { created: index + 1, updated: index + 1 } })),
              total: sessionIDs.length,
            },
          }),
        },
      }
    }
  `,
  "stub-scope-components.tsx": `
    export function ActiveZone() {
      return null
    }

    export function SessionRow(props: { session: { id: string }; isWorking: boolean }) {
      return <div data-session-row={props.session.id} data-working={String(props.isWorking)} />
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
  const topbarPath = path.join(appSrc, "components/top-bar/session-top-bar.tsx")
  const chromePath = path.join(appSrc, "components/app-shell/desktop-window-chrome.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      `
        <!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <div id="app"></div>
        <script type="module" src="/main.tsx"></script>
      `,
    ),
    ...Object.entries(stubModules).map(([name, source]) => Bun.write(path.join(fixtureDirectory, name), source)),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { Router, Route } from "@solidjs/router"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { MobileDrawer } from ${JSON.stringify(`/@fs/${navDrawerPath}`)}
        import { SessionTopBar } from ${JSON.stringify(`/@fs/${topbarPath}`)}
        import { useLayout } from "@/context/layout"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import "@ericsanchezok/synergy-ui/styles"
        import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
        import { DesktopWindowChrome } from ${JSON.stringify(`/@fs/${chromePath}`)}
        import { messages as en } from ${JSON.stringify(`/@fs/${appSrc}/locales/en/messages.po`)}
        import { messages as zh } from ${JSON.stringify(`/@fs/${appSrc}/locales/zh-CN/messages.po`)}

        // The account row derives its text from translated labels, so the drawer
        // is only testable against real catalogs: an empty catalog would make
        // every surface fall back to its message default and hide a stale label.
        const i18n = setupI18n({ locale: "en", messages: { en, "zh-CN": zh } })
        window.__drawerI18n = i18n

        render(
          () => (
            <I18nProvider i18n={i18n}>
              <Router root={props => (
                  <DialogProvider>
                    <MobileDrawer onSearchOpen={() => {}} />
                    <DesktopWindowChrome />
                    {props.children}
                    <button>Background action</button>
                  </DialogProvider>
                )}>
                <Route path="/:dir/session/:id?" component={SessionTopBar} />
                <Route path="*" component={() => <button onClick={() => useLayout().mobileSidebar.show()}>Open navigation</button>} />
              </Router>
            </I18nProvider>
          ),
          document.getElementById("app")!,
        )
      `,
    ),
  ])

  server = await createBrowserFixture({
    root: fixtureDirectory,
    styled: true,
    localized: true,
    aliases: [
      { find: "@/context/layout", replacement: path.join(fixtureDirectory, "stub-layout.ts") },
      { find: "@/context/platform", replacement: path.join(fixtureDirectory, "stub-platform.ts") },
      { find: "@/context/notification", replacement: path.join(fixtureDirectory, "stub-notification.ts") },
      { find: "@/context/global-sync", replacement: path.join(fixtureDirectory, "stub-global-sync.ts") },
      { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "stub-global-sdk.ts") },
      { find: "@/context/workbench", replacement: path.join(fixtureDirectory, "stub-workbench.ts") },
      { find: "@/components/settings", replacement: path.join(fixtureDirectory, "stub-settings.tsx") },
      {
        find: /^@\/context\/(local|command|sync|session-data-view|locale)$/,
        replacement: path.join(fixtureDirectory, "stub-topbar-services.ts"),
      },
      { find: /^@\/components\/dialog$/, replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx") },
      {
        find: /^@\/components\/dialog\/dialog-session-(export|import|transfer)$/,
        replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx"),
      },
      {
        find: /^@\/components\/session\/(worktree-transition-dialog|session-tag-menu)$/,
        replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx"),
      },
      {
        find: "@/components/execution/session-task-details",
        replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx"),
      },
      {
        find: "@/components/provider/model-thinking-picker",
        replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx"),
      },
      { find: "@/plugin/slot-outlet", replacement: path.join(fixtureDirectory, "stub-topbar-components.tsx") },
      {
        find: "@/components/dialog/project-directory-picker",
        replacement: path.join(fixtureDirectory, "stub-project-picker.ts"),
      },
      { find: "@/components/dialog/confirm-dialog", replacement: path.join(fixtureDirectory, "stub-confirm.ts") },
      {
        find: "@/components/scopes/active-zone",
        replacement: path.join(fixtureDirectory, "stub-scope-components.tsx"),
      },
      {
        find: "@/components/scopes/session-row",
        replacement: path.join(fixtureDirectory, "stub-scope-components.tsx"),
      },
      {
        find: "@/components/scopes/pagination-bar",
        replacement: path.join(fixtureDirectory, "stub-scope-components.tsx"),
      },

      { find: "@ericsanchezok/synergy-sdk/client", replacement: path.join(fixtureDirectory, "stub-sdk.ts") },
      { find: "@/", replacement: `${appSrc}/` },
    ],
  })
  fixtureUrl = server.url
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

async function withFixture(
  run: (page: Page) => Promise<void>,
  options: {
    route?: string
    open?: boolean
    reducedMotion?: "reduce" | "no-preference"
    viewport?: { width: number; height: number }
    colorScheme?: "light" | "dark"
  } = {},
) {
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 375, height: 667 },
    colorScheme: options.colorScheme ?? "light",
  })
  page.setDefaultTimeout(5000)
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  try {
    await page.emulateMedia({ reducedMotion: options.reducedMotion ?? "no-preference" })
    await page.goto(new URL(options.route ?? "/", fixtureUrl).href, { waitUntil: "domcontentloaded", timeout: 30000 })
    if (options.open !== false) {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click()
      await page.waitForSelector(".mobile-drawer-overlay", { timeout: 20_000 })
      await page
        .locator(".mobile-drawer-overlay")
        .evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    }
    await page.waitForSelector(".desktop-window-chrome", { timeout: 20_000 })
    expect(pageErrors, `fixture page errors: ${pageErrors.join(" | ")}`).toEqual([])
    await run(page)
    expect(pageErrors, `fixture page errors: ${pageErrors.join(" | ")}`).toEqual([])
  } finally {
    await page.close()
  }
}

async function chromeRegion(page: Page): Promise<string> {
  return page
    .locator(".desktop-window-chrome")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
}

async function waitForChromeRegion(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    (region) => {
      const el = document.querySelector(".desktop-window-chrome")
      return el !== null && getComputedStyle(el).getPropertyValue("-webkit-app-region") === region
    },
    expected,
    { timeout: 10_000 },
  )
}

describe("mobile drawer titlebar drag suspension", () => {
  test("suspends the desktop titlebar drag region while a drawer overlay is open", async () => {
    await withFixture(async (page) => {
      await waitForChromeRegion(page, "no-drag")
      expect(await chromeRegion(page)).toBe("no-drag")

      await page.getByRole("button", { name: "Close navigation" }).click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-overlay").length === 0)
      await waitForChromeRegion(page, "drag")

      await page.getByRole("button", { name: "Open navigation", exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-overlay").length === 1)
      await waitForChromeRegion(page, "no-drag")
    })
  })

  test("close buttons still dismiss the drawer after reopening", async () => {
    await withFixture(async (page) => {
      await page.getByRole("button", { name: "Close navigation" }).click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-overlay").length === 0)

      await page.getByRole("button", { name: "Open navigation", exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-overlay").length === 1)
      await page.locator('[data-action="close"]').click()
      await page.waitForFunction(() => document.querySelectorAll(".mobile-drawer-overlay").length === 0)
    })
  })
})

describe("mobile drawer session status", () => {
  test("reads retry as working, a paused session as not working, and a missing status as idle", async () => {
    await withFixture(async (page) => {
      await page.getByRole("tab", { name: "Projects", exact: true }).click()
      await page.getByRole("button", { name: "Fixture Project", exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll("[data-session-row]").length === 5)

      const working = (sessionID: string) =>
        page.locator(`[data-session-row="${sessionID}"]`).getAttribute("data-working")

      for (const [sessionID, expected] of [
        ["ses_busy", "true"],
        ["ses_retry", "true"],
        ["ses_paused", "false"],
        ["ses_idle", "false"],
        ["ses_missing", "false"],
      ] as const) {
        expect(await working(sessionID), `${sessionID} working flag`).toBe(expected)
      }
    })
  })
})

describe("mobile drawer localization", () => {
  test("the personal space and header follow a locale switch without remounting", async () => {
    await withFixture(async (page) => {
      const account = page.locator(".space-switcher-trigger")
      await account.waitFor()
      expect(await account.innerText()).toContain("Personal space")
      expect(await page.getByRole("button", { name: "Search sessions", exact: true }).count()).toBe(1)

      await page.evaluate(() =>
        (window as unknown as { __drawerI18n: { activate(locale: string): void } }).__drawerI18n.activate("zh-CN"),
      )

      await page.waitForFunction(() =>
        document.querySelector(".space-switcher-trigger")?.textContent?.includes("个人空间"),
      )
      expect(await page.getByRole("button", { name: "搜索会话", exact: true }).count()).toBe(1)
      expect(await account.innerText()).not.toContain("Personal space")
    })
  })
})

describe("single mobile navigation", () => {
  test("personal space is always available and routes providers and repository correctly", async () => {
    await withFixture(async (page) => {
      for (const features of [undefined, [], ["workbench"]]) {
        await page.evaluate(
          (value) => (window as unknown as { setFeatures(value: string[] | undefined): void }).setFeatures(value),
          features,
        )
        const trigger = page.getByRole("button", { name: "Current space", exact: true })
        expect(await trigger.innerText()).toContain("Personal space")
        await trigger.click()
        expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Settings", "Providers", "Repository"])
        await page.getByRole("menuitem", { name: "Providers", exact: true }).click()
        await page.getByRole("heading", { name: "Providers", exact: true }).waitFor()
        await page.keyboard.press("Escape")
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Current space")
        await trigger.click()
        await page.getByRole("menuitem", { name: "Repository", exact: true }).click()
        await page.waitForFunction(() => !!(window as unknown as { openedLink: string }).openedLink)
        expect(await page.evaluate(() => (window as unknown as { openedLink: string }).openedLink)).toBe(
          "https://github.com/SII-Holos/synergy",
        )
      }
    })
  })
  const projectRoute = `/${base64Encode("scp_fixture")}/session/ses_fixture`

  for (const viewport of [
    { width: 320, height: 480 },
    { width: 375, height: 812 },
  ]) {
    test(`keeps identity fixed and every collection and shortcut reachable at ${viewport.width}x${viewport.height}`, async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        await withFixture(
          async (page) => {
            const protocol = await page.context().newCDPSession(page)
            await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } })
            await page.evaluate(() => {
              const fixture = window as unknown as {
                __drawerControl: { populateCollections(): void }
              }
              fixture.__drawerControl.populateCollections()
            })
            const account = page.locator(".mobile-drawer-account")
            const initial = (await account.boundingBox())!
            expect(initial.y).toBeGreaterThan(0)
            expect(initial.y + initial.height).toBeLessThanOrEqual(viewport.height - 34)
            expect(initial.y + initial.height).toBeGreaterThanOrEqual(viewport.height - 50)
            const scrollers = await page.locator(".mobile-drawer-root, .mobile-drawer-root *").evaluateAll((elements) =>
              elements
                .filter((element) => {
                  const style = getComputedStyle(element)
                  return (
                    element.clientHeight > 0 &&
                    element.scrollHeight > element.clientHeight + 1 &&
                    ["auto", "scroll"].includes(style.overflowY)
                  )
                })
                .map((element) => ({
                  collections: !!element.querySelector('[role="tabpanel"]'),
                  destinations: !!element.querySelector("nav"),
                  panels: !!element.querySelector('[role="group"]'),
                })),
            )
            expect(scrollers).toEqual([{ collections: true, destinations: true, panels: true }])
            expect(
              await page.getByRole("region", { name: "Recent", exact: true }).locator("[data-session-id]").count(),
            ).toBe(40)
            await page.mouse.move(100, 200)
            await page.mouse.wheel(0, 1200)
            await page.waitForFunction(() =>
              Array.from(document.querySelectorAll(".mobile-drawer-root, .mobile-drawer-root *")).some(
                (element) => element.scrollTop > 0,
              ),
            )
            expect(await account.boundingBox()).toEqual(initial)

            const expectReachable = async (control: Locator) => {
              await control.scrollIntoViewIfNeeded()
              await control.click({ trial: true })
              const visible = await control.evaluate((element) => {
                const bounds = element.getBoundingClientRect()
                const footer = document.querySelector(".mobile-drawer-account")!.getBoundingClientRect()
                const drawer = document.querySelector(".mobile-drawer-root")!.getBoundingClientRect()
                return {
                  height: bounds.height,
                  width: bounds.width,
                  inside:
                    bounds.left >= drawer.left &&
                    bounds.right <= drawer.right &&
                    bounds.top >= drawer.top &&
                    bounds.bottom <= (element.closest(".mobile-drawer-account") ? footer.bottom : footer.top),
                  hit: element.contains(
                    document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
                  ),
                }
              })
              expect(visible.height).toBeGreaterThanOrEqual(44)
              expect(visible.width).toBeGreaterThanOrEqual(44)
              expect(visible.inside && visible.hit).toBe(true)
              expect(await account.boundingBox()).toEqual(initial)
            }
            await expectReachable(page.locator('[data-session-id="ses_long_39"]'))
            await expectReachable(page.locator('[data-action="load-more-recent"]'))
            for (const control of await page
              .getByRole("navigation", { name: "Tools", exact: true })
              .getByRole("link")
              .all()) {
              await expectReachable(control)
            }
            for (const control of await page
              .getByRole("group", { name: "Workspace panels", exact: true })
              .getByRole("button")
              .all()) {
              await expectReachable(control)
            }
            await page.getByRole("tab", { name: "Projects", exact: true }).click()
            expect(await page.getByRole("button", { name: /^Project \d+ —/ }).count()).toBe(30)
            await expectReachable(page.getByRole("button", { name: /^Project 29 —/ }))
            await expectReachable(page.getByRole("button", { name: "Add project", exact: true }))
            await expectReachable(page.getByRole("button", { name: "Home", exact: true }))
            await expectReachable(page.getByRole("dialog").getByRole("button", { name: "New session", exact: true }))
            await expectReachable(page.getByRole("button", { name: "Current space", exact: true }))
            expect(
              await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true)
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            await page.getByRole("button", { name: "Current space", exact: true }).click()
            await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
            await page.getByRole("dialog", { name: "Settings fixture" }).waitFor()
            await page.keyboard.press("Escape")
            await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Current space")
            expect(await account.boundingBox()).toEqual(initial)
          },
          { viewport, colorScheme, route: projectRoute },
        )
      }
    })
  }

  test("keeps each global destination once and separates capability-gated workspace actions", async () => {
    await withFixture(
      async (page) => {
        const destinations = page.getByRole("navigation", { name: "Tools", exact: true })
        const panels = page.getByRole("group", { name: "Workspace panels", exact: true })
        for (const [label, href] of [
          ["Agenda", "/agenda"],
          ["Library", "/library"],
          ["Performance", "/performance"],
          ["Plugins", "/plugins/marketplace"],
          ["Kanban", "/kanban"],
        ]) {
          expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(1)
          expect(await destinations.getByRole("link", { name: label, exact: true }).getAttribute("href")).toBe(href)
        }
        expect(await panels.getByRole("button", { name: "Notes", exact: true }).count()).toBe(1)
        expect(await panels.getByRole("button", { name: "Browser", exact: true }).count()).toBe(1)
        await panels.getByRole("button", { name: "Browser", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
        expect(await page.evaluate(() => (window as unknown as { openedPanels: string[] }).openedPanels)).toEqual([
          "browser",
        ])
        await page.getByRole("button", { name: "Open navigation", exact: true }).click()
        await page.getByRole("button", { name: "Notes", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
        expect(await page.evaluate(() => (window as unknown as { openedPanels: string[] }).openedPanels)).toEqual([
          "browser",
          "notes",
        ])
        await page.getByRole("button", { name: "Open navigation", exact: true }).click()
        await page.getByRole("link", { name: "Agenda", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
        expect(new URL(page.url()).pathname).toBe("/agenda")
        await page.getByRole("button", { name: "Open navigation", exact: true }).click()
        const setFeatures = (features: string[] | undefined) =>
          page.evaluate((value) => {
            ;(window as unknown as { setFeatures(features: string[] | undefined): void }).setFeatures(value)
          }, features)
        await setFeatures(undefined)
        for (const label of ["Agenda", "Library", "Performance", "Plugins", "Kanban"])
          expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(0)
        for (const label of ["Notes", "Browser"])
          expect(await page.getByRole("button", { name: label, exact: true }).count()).toBe(0)
        await setFeatures(["kanban"])
        expect(await page.getByRole("link", { name: "Kanban", exact: true }).count()).toBe(1)
        await setFeatures(["agenda"])
        expect(await page.getByRole("link", { name: "Kanban", exact: true }).count()).toBe(0)
        expect(await page.getByRole("link", { name: "Agenda", exact: true }).count()).toBe(1)
        await setFeatures([])
        expect(await page.getByRole("link", { name: "Agenda", exact: true }).count()).toBe(0)
        await setFeatures(["note", "browser"])
        await page.evaluate(() => (window as unknown as { setNative(value: boolean): void }).setNative(false))
        expect(await page.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0)
        expect(await page.getByRole("button", { name: "Notes", exact: true }).count()).toBe(1)
        await page.evaluate(() => (window as unknown as { setNative(value: boolean): void }).setNative(true))
        expect(await page.getByRole("button", { name: "Browser", exact: true }).isDisabled()).toBe(true)
        expect(await page.getByRole("button", { name: "Current space", exact: true }).count()).toBe(1)
      },
      { route: projectRoute },
    )
  })

  test("names the modal, traps focus, closes one layer at a time and returns focus", async () => {
    await withFixture(async (page) => {
      const dialog = page.getByRole("dialog", { name: "Navigation", exact: true })
      await dialog.waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close navigation")
      expect(await page.getByRole("button", { name: "Background action" }).count()).toBe(0)
      for (let index = 0; index < 24; index++) {
        await page.keyboard.press(index < 12 ? "Tab" : "Shift+Tab")
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      }
      await page.getByRole("button", { name: "Current space", exact: true }).click()
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
      await page.getByRole("dialog", { name: "Settings fixture" }).waitFor()
      await dialog.waitFor({ state: "hidden" })
      expect(await dialog.count()).toBe(0)
      await page.keyboard.press("Escape")
      await dialog.waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Current space")
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.textContent === "Open navigation")
      await page.getByRole("button", { name: "Open navigation", exact: true }).click()
      await dialog.waitFor()
      await page.setViewportSize({ width: 1024, height: 667 })
      await page.getByRole("dialog").waitFor({ state: "detached" })
      expect(await page.getByRole("button", { name: "Background action" }).count()).toBe(1)
    })
  })

  test("uses calm horizontal rows without duplicate Recent text or overflow at 375px", async () => {
    await withFixture(async (page) => {
      expect(await page.getByRole("region", { name: "Recent", exact: true }).count()).toBe(1)
      expect(await page.getByRole("heading", { name: "Recent", exact: true }).count()).toBe(0)
      const links = page.getByRole("navigation", { name: "Tools", exact: true }).getByRole("link")
      const rows = await links.evaluateAll((elements) =>
        elements.map((element) => {
          const icon = element.querySelector("svg")!.getBoundingClientRect()
          const label = element.querySelector("span")!.getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          return {
            height: bounds.height,
            width: bounds.width,
            font: getComputedStyle(element).fontSize,
            iconWidth: icon.width,
            horizontal: label.left >= icon.right,
            centered: Math.abs(label.y + label.height / 2 - icon.y - icon.height / 2) < 1,
          }
        }),
      )
      expect(rows.length).toBe(5)
      for (const row of rows) {
        expect(row.height).toBeGreaterThanOrEqual(44)
        expect(row.font).toBe("14px")
        expect(row.iconWidth).toBe(20)
        expect(row.horizontal && row.centered).toBe(true)
      }
      const first = await links.nth(0).boundingBox()
      const second = await links.nth(1).boundingBox()
      expect(first?.y).toBe(second?.y)
      expect(first!.x).toBe(16)
      const newAction = page.getByRole("dialog").getByRole("button", { name: "New session", exact: true })
      expect((await newAction.boundingBox())?.height).toBe(44)
      expect(await newAction.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      const close = page.getByRole("button", { name: "Close navigation", exact: true })
      await page.mouse.move(374, 666)
      expect(await close.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.keyboard.press("Tab")
      expect(
        await page.evaluate(() => {
          const focused = document.activeElement!
          const style = getComputedStyle(focused)
          return (
            focused.matches(":focus-visible") &&
            (style.backgroundImage !== "none" || style.outlineStyle !== "none" || style.boxShadow !== "none")
          )
        }),
      ).toBe(true)
    })
  })

  test("New preserves project context and remains reachable from non-session destinations", async () => {
    await withFixture(
      async (page) => {
        await page.getByRole("dialog").getByRole("button", { name: "New session", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
        expect(new URL(page.url()).pathname).toBe(`/${base64Encode("scp_fixture")}/session`)
      },
      { route: projectRoute },
    )
    await withFixture(
      async (page) => {
        await page.getByRole("dialog").getByRole("button", { name: "New session", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
        expect(new URL(page.url()).pathname).toBe(`/${base64Encode("home")}/session`)
      },
      { route: "/agenda" },
    )
  })

  test("top bar has one navigation entry and keeps long model names clear of 44px controls", async () => {
    await withFixture(
      async (page) => {
        expect(await page.getByRole("button", { name: "Open tools", exact: true }).count()).toBe(0)
        expect(await page.getByRole("button", { name: "Open navigation", exact: true }).count()).toBe(1)
        expect((await page.locator("[data-session-top-bar]").boundingBox())?.height).toBe(48)
        const navigation = await page.getByRole("button", { name: "Open navigation", exact: true }).boundingBox()
        const newAction = await page.getByRole("button", { name: "New session", exact: true }).boundingBox()
        for (const bounds of [navigation, newAction]) {
          expect(bounds?.width).toBe(44)
          expect(bounds?.height).toBe(44)
        }
        const model = page.getByRole("button", { name: "Choose model", exact: true })
        const bounds = (await model.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(navigation!.x + navigation!.width)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(newAction!.x)
        expect(
          await model.locator(".stb-selector-label").evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(true)
        const controls = await page.locator("[data-session-top-bar] button").evaluateAll((elements) =>
          elements
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => {
              const bounds = element.getBoundingClientRect()
              return bounds.x >= 0 && bounds.right <= innerWidth
            }),
        )
        expect(controls.every(Boolean)).toBe(true)
        await page.getByRole("button", { name: "New session", exact: true }).click()
        expect(new URL(page.url()).pathname).toBe(`/${base64Encode("scp_fixture")}/session`)
        await page.setViewportSize({ width: 1024, height: 667 })
        await page.getByRole("button", { name: "Open side workspace", exact: true }).waitFor()
        expect(await page.getByRole("button", { name: "Open BottomSpace", exact: true }).count()).toBe(1)
        expect(await page.getByRole("button", { name: "Open navigation", exact: true }).count()).toBe(0)
      },
      { route: projectRoute, open: false },
    )
  })

  test("coordinates exit and rapid close/reopen without a stale modal or focus trap", async () => {
    await withFixture(async (page) => {
      const exit = await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('[data-action="close"]')!.click()
        const content = document.querySelector<HTMLElement>('[role="dialog"]')
        const overlay = document.querySelector<HTMLElement>('[data-component="dialog-overlay"]')
        return {
          retained: !!content,
          contentDuration: content && getComputedStyle(content).animationDuration,
          overlayDuration: overlay && getComputedStyle(overlay).animationDuration,
        }
      })
      expect(exit.retained).toBe(true)
      expect(exit.contentDuration).toBe("0.18s")
      expect(exit.overlayDuration).toBe(exit.contentDuration)
      await page.evaluate(() =>
        (window as unknown as { __drawerControl: { openMobile(): void } }).__drawerControl.openMobile(),
      )
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"))
      expect(await page.getByRole("dialog", { name: "Navigation", exact: true }).count()).toBe(1)
      await page.keyboard.press("Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.textContent === "Open navigation")
      await page.keyboard.press("Tab")
      expect(await page.evaluate(() => !document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    })
  })

  test("reduced motion opens and closes statically", async () => {
    await withFixture(
      async (page) => {
        expect(await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).transform)).toBe("none")
        expect(await page.getByRole("dialog").evaluate((element) => element.getAnimations().length)).toBe(0)
        const exitAnimations = await page.evaluate(() => {
          document.querySelector<HTMLButtonElement>('[data-action="close"]')!.click()
          return document.querySelector('[role="dialog"]')?.getAnimations().length ?? 0
        })
        expect(exitAnimations).toBe(0)
        await page.getByRole("dialog").waitFor({ state: "detached" })
        await page.waitForFunction(() => document.activeElement?.textContent === "Open navigation")
      },
      { reducedMotion: "reduce" },
    )
  })
})
