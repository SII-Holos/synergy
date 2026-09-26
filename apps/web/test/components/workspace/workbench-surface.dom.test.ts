import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
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
      const tabs = [{ id, panelId: id }]
      return [id, { opened, setOpened, close: () => setOpened(false), size, setSize, tabs: () => tabs,
        activeTab: () => tabs[0], active: () => id, setActive: () => {} }]
    }))
    window.fixture = { open: id => states[id].setOpened(true), close: id => states[id].close(), crash: setCrash, resize: (id,size) => states[id].setSize(size), size: id => states[id].size() }
    export const useWorkbenchPanels = () => ({
      surface: id => states[id], panels: () => entries, panelForTab: tab => entries.find(x => x.id === tab?.panelId),
      panelTitle: tab => tab.panelId, openPanel: () => {}, closeTab: () => {}, closeOtherTabs: () => {}, moveTab: () => {}
    })
    export const useLayout = () => ({ isDesktop: () => true, sidebar: { opened: () => false, width: () => 250 } })
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
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "./state"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    function Fixture() {
      const dialog = useDialog()
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
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

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
  }
}

async function openSurfaces() {
  errors.length = 0
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "Open bottom", exact: true }).click()
  await page.getByRole("button", { name: "bottom action" }).waitFor()
}

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
    () => parseFloat((document.querySelector(".workbench-surface--side") as HTMLElement).style.width) <= 452,
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
