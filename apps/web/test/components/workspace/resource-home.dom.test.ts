import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"
import type { WorkbenchPanelEntry, WorkbenchPanelTab } from "../../../src/plugin/registries/workbench-panel-registry"

let directory: string
let browser: Browser
let context: BrowserContext
let page: Page
let server: ViteDevServer
let baseUrl: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const labels = ["Notes", "Context", "Review", "Lattice", "Files", "Boss"]

type ResourceMetadata = Pick<WorkbenchPanelEntry, "id" | "label"> &
  Partial<Pick<WorkbenchPanelEntry, "surface" | "cardinality" | "order" | "launchable" | "requiresSession" | "icon">>

interface ResourceHomeWindow extends Window {
  fixture: {
    register(entry: ResourceMetadata): void
    remove(id: string): void
    session(present: boolean): void
    tabs(): WorkbenchPanelTab[]
    open(panelId: string): Promise<void>
    close(tabId: string): Promise<void>
    created: string[]
    loaded: string[]
  }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".resource-home-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root" class="synergy-workbench-canvas"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    import { setupI18n } from "@lingui/core"
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    export const i18n = setupI18n({ locale: "en", messages: { en } })
    export const useLocale = () => ({ i18n })
    export const useConfirm = () => ({ ask: async () => true })
    const surfaces = new Map()
    function surface(key, name) {
      const identity = key + ":" + name
      if (surfaces.has(identity)) return surfaces.get(identity)
      const [tabs, setTabs] = createSignal(name === "side" ? [{ id: "empty", panelId: "resource-home" }] : [])
      const [active, setActive] = createSignal("empty")
      const [opened, setOpened] = createSignal(name === "side")
      const [size, setSize] = createSignal(720)
      const [fullscreen, setFullscreen] = createSignal(true)
      const [reveal, setReveal] = createSignal({})
      const value = { tabs, setTabs, active, setActive, activeTab: () => tabs().find(tab => tab.id === active()),
        opened, open: () => setOpened(true), close: () => setOpened(false), toggle: () => setOpened(!opened()),
        size, setSize, fullscreen, setFullscreen, reveal, setReveal }
      surfaces.set(identity, value)
      return value
    }
    export const useLayout = () => ({ surface, transferWorkbenchState() {}, isDesktop: () => true,
      sidebar: { opened: () => false, width: () => 260, occupiedWidth: () => 0 } })
    `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { I18nProvider } from "@lingui/solid"
    import { MemoryRouter, Route, createMemoryHistory, useNavigate } from "@solidjs/router"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
    import { WorkbenchPanelsProvider, useWorkbenchPanels } from ${JSON.stringify(`/@fs/${source}/context/workbench/index.tsx`)}
    import { ResourceHome } from ${JSON.stringify(`/@fs/${source}/components/workspace/resource-home.tsx`)}
    import { WorkbenchSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/workbench-surface.tsx`)}
    import { registerWorkbenchPanel } from ${JSON.stringify(`/@fs/${source}/plugin/registries/workbench-panel-registry.ts`)}
    import { i18n } from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const created = [], loaded = []
    const disposers = new Map()
    function register(metadata) {
      disposers.get(metadata.id)?.()
      disposers.set(metadata.id, registerWorkbenchPanel({ surface: "side", cardinality: "multi", icon: getSemanticIcon("workspace.files"), ...metadata,
        createTab: async () => { created.push(metadata.id); return { title: metadata.label } },
        loader: async () => { loaded.push(metadata.id); return { default: () => <div>{metadata.label} content</div> } }
      }))
    }
    registerWorkbenchPanel({ id: "resource-home", label: "New tab", icon: getSemanticIcon("workspace.newTab"), surface: "side", cardinality: "multi", launchable: false, component: ResourceHome })
    register({ id: "notes", label: "Notes", icon: getSemanticIcon("notes.main"), order: 10 })
    register({ id: "context", label: "Context", icon: getSemanticIcon("session.context"), order: 11, cardinality: "singleton", requiresSession: true })
    register({ id: "session-review", label: "Review", icon: getSemanticIcon("command.review"), order: 12, cardinality: "singleton", requiresSession: true })
    register({ id: "lattice", label: "Lattice", icon: getSemanticIcon("prompt.lattice"), order: 13, cardinality: "singleton", requiresSession: true })
    register({ id: "file", label: "Files", order: 14 })
    register({ id: "boss", label: "Boss", icon: getSemanticIcon("prompt.boss"), order: 15, cardinality: "singleton", requiresSession: true })
    register({ id: "attachment", label: "Attachment", launchable: false })
    register({ id: "terminal", label: "Terminal", surface: "bottom" })
    function Fixture() {
      const workbench = useWorkbenchPanels()
      const navigate = useNavigate()
      window.fixture = { register, remove: id => disposers.get(id)?.(), created, loaded,
        session: present => navigate("/home/session" + (present ? "/task" : "")),
        tabs: () => workbench.surface("side").tabs(),
        open: async panelId => { await workbench.openPanel(panelId, { forceNew: true }) },
        close: async tabId => { await workbench.closeTab(tabId) } }
      return <div style="height:100dvh;position:relative"><WorkbenchSurface surface="side" /></div>
    }
    const history = createMemoryHistory()
    history.set({ value: "/home/session/task" })
    render(() => <I18nProvider i18n={i18n}><DialogProvider><MemoryRouter history={history}>
      <Route path="/:dir/session/:id?" component={() => <WorkbenchPanelsProvider><Fixture /></WorkbenchPanelsProvider>} />
    </MemoryRouter></DialogProvider></I18nProvider>, document.querySelector("#root"))
    `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [
      {
        name: "resource-home-layout-fixture",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "../layout" && importer === path.join(source, "context/workbench/index.tsx"))
            return path.join(directory, "services.ts")
        },
      },
      solidPlugin(),
      tailwindcss(),
      ...lingui(),
    ],
    resolve: {
      alias: [
        { find: /^@\/context\/(layout|locale)$/, replacement: path.join(directory, "services.ts") },
        { find: "@/components/dialog/confirm-dialog", replacement: path.join(directory, "services.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  errors.length = 0
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" })
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseUrl, { timeout: 60000 })
  await page.getByRole("heading", { name: "New tab", exact: true }).waitFor()
}, 70000)

afterEach(async () => {
  try {
    expect(errors).toEqual([])
  } finally {
    await context?.close()
  }
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

const cards = () => page.locator(".resource-home-card")

async function menuLabels() {
  await page.getByRole("button", { name: "Open a resource", exact: true }).click()
  const values = await page.getByRole("menuitem").allTextContents()
  await page.keyboard.press("Escape")
  return values
}

async function entryIcons(selector: string) {
  return page
    .locator(selector)
    .evaluateAll((elements) => elements.map((element) => element.querySelector("svg")?.innerHTML))
}

test("new-tab cards match all launchable side resources without loading implementations", async () => {
  expect(await menuLabels()).toEqual(labels)
  expect(await cards().allTextContents()).toEqual(labels)
  await page.getByRole("button", { name: "Open a resource", exact: true }).click()
  expect(await entryIcons(".resource-home-card")).toEqual(await entryIcons('[role="menuitem"]'))
  await page.keyboard.press("Escape")
  expect(await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.created)).toEqual([])
  expect(await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.loaded)).toEqual([])
})

test("registration, removal and relabeling update cards and menu in the same order", async () => {
  const previousIcons = await entryIcons(".resource-home-card")
  expect(previousIcons.every(Boolean)).toBe(true)
  await page.getByRole("button", { name: "Open a resource", exact: true }).click()
  await page.evaluate(() => {
    const fixture = (window as unknown as ResourceHomeWindow).fixture
    fixture.register({ id: "plugin:document", label: "Plugin document", order: 13.5 })
    fixture.register({ id: "file", label: "Project files", icon: "plus", order: 14 })
    fixture.remove("boss")
  })
  const expected = ["Notes", "Context", "Review", "Lattice", "Plugin document", "Project files"]
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(expected)
  expect(await cards().allTextContents()).toEqual(expected)
  expect(await entryIcons(".resource-home-card")).toEqual(await entryIcons('[role="menuitem"]'))
  expect((await entryIcons(".resource-home-card")).at(-1)).not.toBe(previousIcons[4])
})

test("an empty resource catalog keeps its recovery message and omits unavailable menu choices", async () => {
  await page.evaluate(() => {
    const fixture = (window as unknown as ResourceHomeWindow).fixture
    fixture.session(false)
    fixture.remove("notes")
    fixture.remove("file")
  })
  await page.getByText("No resources are available in this project.", { exact: true }).waitFor()
  expect(await cards().count()).toBe(0)
  expect(await page.getByRole("button", { name: "Open a resource", exact: true }).count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as ResourceHomeWindow).fixture.register({ id: "plugin:recovered", label: "Recovered resource" }),
  )
  expect(await cards().allTextContents()).toEqual(["Recovered resource"])
  expect(await menuLabels()).toEqual(["Recovered resource"])
})

test("session availability and Browser registration reach both resource entry points", async () => {
  await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.session(false))
  expect(await menuLabels()).toEqual(["Notes", "Files"])
  expect(await cards().allTextContents()).toEqual(["Notes", "Files"])
  await page.evaluate(() =>
    (window as unknown as ResourceHomeWindow).fixture.register({ id: "browser", label: "Browser", order: 20 }),
  )
  expect(await menuLabels()).toEqual(["Notes", "Files", "Browser"])
  expect(await cards().allTextContents()).toEqual(["Notes", "Files", "Browser"])
  expect(await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.created)).toEqual([])
  await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.remove("browser"))
  expect(await cards().allTextContents()).toEqual(["Notes", "Files"])
})

test("choosing a registered card fills the captured empty tab and singleton choices follow open tabs", async () => {
  await cards().getByText("Context", { exact: true }).click()
  await page.getByText("Context content", { exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.tabs())).toMatchObject([
    { id: "empty", panelId: "context" },
  ])
  await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.open("resource-home"))
  await page.getByRole("heading", { name: "New tab", exact: true }).waitFor()
  expect(await menuLabels()).toEqual(labels.filter((label) => label !== "Context"))
  expect(await cards().allTextContents()).toEqual(labels.filter((label) => label !== "Context"))
  await page.evaluate(() => (window as unknown as ResourceHomeWindow).fixture.close("empty"))
  expect(await cards().allTextContents()).toEqual(labels)
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`many resource cards stay reachable in narrow and short ${colorScheme} layouts`, async () => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
    await page.evaluate(() => {
      for (let index = 0; index < 18; index++)
        (window as unknown as ResourceHomeWindow).fixture.register({
          id: `plugin:${index}`,
          label: index === 17 ? "WorkspaceResource".repeat(6) : `Long plugin resource title ${index}`,
          order: 100 + index,
        })
    })
    for (const width of [1024, 375]) {
      await page.setViewportSize({ width, height: 360 })
      expect(await cards().count()).toBe(24)
      expect(
        await page.locator(".resource-home").evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true)
      await cards().first().focus()
      for (let index = 1; index < 24; index++) await page.keyboard.press("Tab")
      const bounds = await cards().last().boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      expect(bounds!.y).toBeGreaterThanOrEqual(48)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(361)
      expect(
        await cards()
          .last()
          .evaluate((element) => element === document.activeElement),
      ).toBe(true)
    }
  })
}
