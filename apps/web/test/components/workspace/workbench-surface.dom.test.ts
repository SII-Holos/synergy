import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let context: BrowserContext
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".workbench-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "state.tsx"),
    `
    import { createSignal } from "solid-js"
    export const [crash, setCrash] = createSignal(false)
    window.mounts = { side: 0, bottom: 0 }
    const entries = ["side", "bottom", "extra"].map(id => ({
      id, label: id, icon: "file", surfaces: ["side", "bottom"], cardinality: "multi",
      component: () => { window.mounts[id]++; return <div>
        {(() => { if (crash() && id === "side") throw new Error("Panel crashed"); return null })()}
        <button>{id} action</button><input aria-label={id + " draft"} />
      </div> }
    }))
    const states = Object.fromEntries(["side", "bottom"].map(id => {
      const [opened, setOpened] = createSignal(false)
      const [size, setSize] = createSignal(id === "side" ? 360 : 200)
      const [fullscreen, setFullscreen] = createSignal(false)
      const [tabs, setTabs] = createSignal([{ id, panelId: id }])
      const [active, setActive] = createSignal(id)
      return [id, { opened, setOpened, close: () => setOpened(false), size, setSize, tabs, setTabs,
        fullscreen, setFullscreen, activeTab: () => tabs().find(tab => tab.id === active()), active, setActive }]
    }))
    window.fixture = { open: id => states[id].setOpened(true), close: id => states[id].close(), crash: setCrash, resize: (id,size) => states[id].setSize(size), size: id => states[id].size(), populate: () => states.side.setTabs(Array.from({length:20}, (_,i) => ({ id: i ? 'tab-'+i : 'side', panelId:'side', title: 'Long document title ' + i }))) }
    export const useWorkbenchPanels = () => ({
      surface: id => states[id], panels: () => entries, panelForTab: tab => entries.find(x => x.id === tab?.panelId),
      interact() {}, activateTab(name, id) { states[name].setActive(id) }, getPanel: id => entries.find(entry => entry.id === id),
      panelTitle: tab => tab.title ?? tab.panelId, openPanel: () => {}, closeTab: () => {}, closeOtherTabs: () => {}, moveTab: () => {}
    })
    export const useLayout = () => ({ isDesktop: () => true, sidebar: { opened: () => false, width: () => 250, occupiedWidth: () => 0 } })
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
    import { WorkbenchSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/workbench-surface.tsx`)}
    import { WorkspaceNavigator } from ${JSON.stringify(`/@fs/${source}/components/workspace/workspace-navigator.tsx`)}
    import { DefaultSession } from ${JSON.stringify(`/@fs/${source}/plugin/default-session.tsx`)}
    import { DefaultShell } from ${JSON.stringify(`/@fs/${source}/plugin/default-shell.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/components/top-bar/session-top-bar.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/sidebar/sidebar.css`)}
    import { createSignal } from "solid-js"
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "./state"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    function NavigatorProbe() {
      const [open, setOpen] = createSignal(true)
      let navigation
      return <div data-ui-part="resource-panel" style="width:100vw;height:400px;display:flex">
        <WorkspaceNavigator label="Documents" open={open()} width={320} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onResize={() => {}} onReady={value => navigation = value}>
          <button onClick={() => navigation.closeDrawer()}>Select document</button>
        </WorkspaceNavigator>
        <button onClick={() => navigation.toggle()}>Toggle navigation</button>
      </div>
    }
    function Fixture() {
      const dialog = useDialog()
      if (location.search === "?navigator-nested") return <button onClick={() => dialog.push(() => <Dialog title="Workspace"><NavigatorProbe /></Dialog>)}>Open host</button>
      if (location.search === "?composed") return <div style="height:100dvh;display:flex;flex-direction:column">
        <DefaultShell context={{ shell: { render: part => part === "navigation" ?
          <aside class="sb-integrated sb-collapsed" style="width:0px"><div class="sb-navigation"><button>Navigation</button></div></aside> : part === "route" ?
          <DefaultSession context={{ layout: { minimumWidth: () => 350, promptHeight: () => 120, render: view => view === "workbench.side" ? <WorkbenchSurface surface="side" /> : view === "conversation" ? <button onClick={() => window.fixture.open("side")}>Open side</button> : view === "composer" ? <div style="position:absolute;bottom:0;left:0;right:0;z-index:50"><input aria-label="Composer draft" /></div> : null } }} /> : null }}} />
      </div>
      if (location.search) return <NavigatorProbe />
      return <>
        <button onClick={() => window.fixture.open("side")}>Open side</button>
        <button onClick={() => window.fixture.open("bottom")}>Open bottom</button>
        <button onClick={() => dialog.push(() => <Dialog title="Nested dialog"><button>Dialog action</button></Dialog>)}>Open dialog</button>
        <div style="height: 400px"><WorkbenchSurface surface="side" /></div>
        <WorkbenchSurface surface="bottom" />
        <button>After workspaces</button>
      </>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: /^@\/context\/(workbench|layout)$/, replacement: path.join(directory, "state.tsx") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  errors.length = 0
  context = await browser.newContext({ viewport: { width: 1200, height: 1000 } })
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
})

afterEach(async () => {
  await context?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface WorkbenchWindow extends Window {
  mounts: Record<string, number>
  fixture: {
    open(id: string): void
    close(id: string): void
    crash(value: boolean): void
    resize(id: string, size: number): void
    size(id: string): number
    populate(): void
  }
}

async function openSurfaces() {
  errors.length = 0
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "Open bottom", exact: true }).click()
  await page.getByRole("button", { name: "bottom action" }).waitFor()
}

test("fullscreen owns display and hit testing without discarding the composer", async () => {
  await page.goto(baseUrl + "?composed")
  await page.getByRole("textbox", { name: "Composer draft" }).fill("Keep this unsent draft")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "Expand workspace", exact: true }).click()
  expect(await page.getByRole("textbox", { name: "Composer draft" }).isVisible()).toBe(false)
  expect(await page.getByRole("button", { name: "Navigation", exact: true }).isVisible()).toBe(false)
  const tab = page.getByRole("tab", { name: "side", exact: true })
  await tab.click({ timeout: 2000 })
  await page.getByRole("button", { name: "Restore view", exact: true }).click()
  expect(await page.getByRole("textbox", { name: "Composer draft" }).inputValue()).toBe("Keep this unsent draft")
  expect(errors).toEqual([])
})

test("resource actions stay reachable when twenty long tabs overflow at 375px", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.populate())
  const add = page.getByRole("button", { name: "New tab", exact: true })
  const rect = await add.boundingBox()
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(375)
  await add.click({ timeout: 2000 })
  await page.getByRole("button", { name: "Open a resource", exact: true }).click({ timeout: 2000 })
  await page.getByRole("menuitem", { name: "extra", exact: true }).waitFor()
})

test("rapid reverse operations retain the mounted resource and its draft", async () => {
  await page.setViewportSize({ width: 1200, height: 1000 })
  await openSurfaces()
  await page.getByRole("textbox", { name: "side draft" }).fill("Retained during reversal")
  for (let index = 0; index < 4; index++) {
    await page
      .locator(".workbench-surface--side")
      .getByRole("button", { name: "Collapse workspace", exact: true })
      .click()
    await page.getByRole("button", { name: "Open side", exact: true }).click()
  }
  expect(await page.getByRole("textbox", { name: "side draft" }).inputValue()).toBe("Retained during reversal")
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.side)).toBe(1)
  expect(await page.locator(".workbench-surface--side").getAttribute("aria-hidden")).toBe("false")
})

test("closed workspaces cannot receive focus and preserve their draft when reopened", async () => {
  await openSurfaces()
  const draft = page.getByRole("textbox", { name: "side draft" })
  await draft.fill("keep this draft")
  const mounts = await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.side)
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.close("side"))
  await page.waitForFunction(() => document.activeElement?.textContent === "Open side")
  await page.locator('input[aria-label="side draft"]').evaluate((el) => (el as HTMLElement).focus())
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).not.toBe("side draft")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  expect(await draft.inputValue()).toBe("keep this draft")
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.side)).toBe(mounts)
  expect(errors).toEqual([])
})

test("Escape leaves background surfaces intact and closes only the focused workspace", async () => {
  await openSurfaces()
  await page.getByRole("button", { name: "After workspaces" }).focus()
  await page.keyboard.press("Escape")
  expect(await page.getByRole("button", { name: "side action" }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "bottom action" }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "side action" }).focus()
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")?.getAttribute("aria-hidden") === "true",
  )
  expect(await page.getByRole("button", { name: "bottom action" }).isVisible()).toBe(true)
})

test("a tab menu and nested dialog each consume one Escape without collapsing workspaces", async () => {
  await openSurfaces()
  await page.getByRole("tab", { name: "side", exact: true }).click({ button: "right" })
  await page.getByRole("menu").waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("menu").waitFor({ state: "detached" })
  expect(await page.getByRole("button", { name: "side action" }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "bottom action" }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Open dialog" }).click()
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.getByRole("button", { name: "bottom action" }).isVisible()).toBe(true)
})

test("bottom resize starts at the top edge and grows when dragged upward", async () => {
  await openSurfaces()
  const root = page.locator(".workbench-surface--bottom")
  const handle = root.getByRole("separator")
  const box = (await handle.boundingBox())!
  const before = (await root.boundingBox())!
  expect(Math.abs(box.y - before.y)).toBeLessThan(6)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y - 50)
  await page.mouse.up()
  await page.waitForFunction(
    () =>
      Number(document.querySelector('.workbench-surface--bottom [role="separator"]')?.getAttribute("aria-valuenow")) >
      240,
  )
  await handle.focus()
  const size = Number(await handle.getAttribute("aria-valuenow"))
  await page.keyboard.press("ArrowUp")
  expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(size)
})

test("panel retry resets the failed panel without remounting its sibling", async () => {
  await openSurfaces()
  const mounts = await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.bottom)
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.crash(true))
  await page.getByText("This panel encountered a problem.").waitFor()
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.crash(false))
  await page.getByRole("button", { name: "Retry panel" }).click()
  await page.getByRole("button", { name: "side action" }).waitFor()
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.bottom)).toBe(mounts)
  expect(errors).toEqual([])
})

test("resizing available space constrains both panels without overwriting preferred sizes", async () => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await openSurfaces()
  await page.evaluate(() => {
    const fixture = (window as unknown as WorkbenchWindow).fixture
    fixture.resize("side", 640)
    fixture.resize("bottom", 500)
  })
  const side = page.locator(".workbench-surface--side")
  const bottom = page.locator(".workbench-surface--bottom")
  await page.setViewportSize({ width: 850, height: 600 })
  await page.waitForFunction(
    () => parseFloat((document.querySelector(".workbench-surface--side") as HTMLElement).style.width) === 500,
  )
  expect(await bottom.evaluate((node) => parseFloat((node as HTMLElement).style.height))).toBeLessThanOrEqual(360)
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.size("side"))).toBe(640)
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.size("bottom"))).toBe(500)
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.waitForFunction(
    () => (document.querySelector(".workbench-surface--side") as HTMLElement).style.width === "640px",
  )
  expect(await side.evaluate((node) => parseFloat((node as HTMLElement).style.width))).toBe(640)
  expect(await bottom.evaluate((node) => parseFloat((node as HTMLElement).style.height))).toBe(500)
})

test("navigation drawers start closed and preserve the wide navigation preference", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator")
  await page.getByRole("button", { name: "Toggle navigation" }).waitFor()
  expect(await page.getByRole("dialog").count()).toBe(0)
  await page.getByRole("button", { name: "Toggle navigation" }).click()
  await page.getByRole("dialog", { name: "Documents" }).waitFor()
  await page.getByRole("button", { name: "Select document" }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Toggle navigation")
  await page.setViewportSize({ width: 768, height: 900 })
  await page.getByRole("complementary", { name: "Documents" }).waitFor()
  expect(await page.getByRole("complementary").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(320)
  await page.setViewportSize({ width: 1200, height: 1000 })
}, 30000)

test("Escape closes a nested navigation drawer and returns focus inside its workspace host", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator-nested")
  await page.getByRole("button", { name: "Open host" }).click()
  await page.getByRole("button", { name: "Toggle navigation" }).click()
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor({ state: "detached" })
  expect(await page.getByRole("dialog", { name: "Workspace", exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Toggle navigation")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.setViewportSize({ width: 1200, height: 1000 })
}, 30000)

test("the automatic workspace overlay contains keyboard focus and restores the preferred width", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  const panel = page.locator(".workbench-surface--side")
  await panel.getByRole("textbox", { name: "side draft" }).focus()
  await page.keyboard.press("Tab")
  expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.waitForFunction(() => !document.querySelector(".workbench-surface--side")?.hasAttribute("aria-modal"))
  await page.waitForFunction(
    () => Math.round(document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width) === 360,
  )
  expect(Math.round((await panel.boundingBox())!.width)).toBe(360)
}, 30000)
