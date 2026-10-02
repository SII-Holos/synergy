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
    '<div id="root" class="synergy-workbench-canvas"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "state.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    export const [crash, setCrash] = createSignal(false)
    window.mounts = { side: 0, bottom: 0, extra: 0 }
    const entries = ["side", "bottom", "extra"].map(id => ({
      id, label: id, icon: "file", surfaces: ["side", "bottom"], cardinality: "multi",
      component: () => { window.mounts[id]++; return <div>
        {(() => { if (crash() && id === "side") throw new Error("Panel crashed"); return null })()}
        <button>{id} action</button><input aria-label={id + " draft"} />
      </div> }
    }))
    const states = Object.fromEntries(["side", "bottom"].map(id => {
      const restored = id === "side" && location.search === "?restored"
      const [opened, setOpened] = createSignal(restored)
      const [size, setSize] = createSignal(id === "side" ? 360 : 200)
      const [fullscreen, setFullscreen] = createSignal(false)
      const [tabs, setTabs] = createSignal(restored ? [{ id, panelId: id }, {id:"restored-extra",panelId:"extra"}] : [{ id, panelId: id }])
      const [active, setActive] = createSignal(id)
      return [id, { opened, setOpened, close: () => setOpened(false), size, setSize, tabs, setTabs,
        fullscreen, setFullscreen, activeTab: () => tabs().find(tab => tab.id === active()), active, setActive }]
    }))
    window.fixture = { retarget: () => states.side.setTabs([{id:"side",panelId:"extra"}]), open: id => states[id].setOpened(true), close: id => states[id].close(), crash: setCrash, resize: (id,size) => states[id].setSize(size), size: id => states[id].size(), populate: () => states.side.setTabs(Array.from({length:20}, (_,i) => ({ id: i ? 'tab-'+i : 'side', panelId:'side', title: 'Long document title ' + i }))) }
    export const useWorkbenchPanels = () => ({
      surface: id => states[id], panels: () => entries, panelForTab: tab => entries.find(x => x.id === tab?.panelId),
      interact() {}, activateTab(name, id) { states[name].setActive(id) }, getPanel: id => entries.find(entry => entry.id === id),
      panelTitle: tab => tab.title ?? tab.panelId, openPanel: () => {}, closeTab: () => {}, closeOtherTabs: () => {}, moveTab: () => {}
    })
    export const useLayout = () => ({ isDesktop: () => true, sidebar: { opened: () => location.search === "?composed", width: () => 260, occupiedWidth: () => location.search === "?composed" ? 260 : 0 } })
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render, Portal } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
    import { WorkbenchSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/workbench-surface.tsx`)}
    import { WorkspaceNavigator } from ${JSON.stringify(`/@fs/${source}/components/workspace/workspace-navigator.tsx`)}
    import { DefaultSession } from ${JSON.stringify(`/@fs/${source}/plugin/default-session.tsx`)}
    import { DefaultShell } from ${JSON.stringify(`/@fs/${source}/plugin/default-shell.tsx`)}
    import { SessionWorkbenchChrome } from ${JSON.stringify(`/@fs/${source}/components/session/workbench-chrome.ts`)}
    import ${JSON.stringify(`/@fs/${source}/components/top-bar/session-top-bar.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/sidebar/sidebar.css`)}
    import { createSignal, useContext } from "solid-js"
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "./state"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    function WorkspaceToggleProbe() {
      const mount = useContext(SessionWorkbenchChrome)
      return <Show when={mount?.()}>{element => <Portal mount={element()}><button class="stb-icon-btn" onClick={() => window.fixture.open("side")}>Open side</button></Portal>}</Show>
    }
    function NavigatorProbe(props = {}) {
      const [open, setOpen] = createSignal(true)
      const [revision, setRevision] = createSignal(1)
      let navigation
      return <div data-ui-part="resource-panel" style={{width:props.width ?? "100vw",height:"400px",display:"flex"}}>
        <WorkspaceNavigator id={props.navigationId ?? (props.remount ? "file-navigation" : undefined)} label="Documents" header={location.search !== "?navigator-own-header"} open={open()} width={320} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onResize={() => {}} onReady={value => navigation = value}>
          <button onClick={() => {setRevision(value => value+1); props.remount?.(); navigation.closeDrawer()}}>Select document</button>
          {location.search === "?navigator-own-header" && <button onClick={() => navigation.closeDrawer()}>Close documents</button>}
        </WorkspaceNavigator>
        <Show when={revision()} keyed>{() => <button data-workspace-navigation-toggle aria-controls={navigation.id} aria-expanded={navigation.opened()} onClick={() => navigation.toggle()}>Toggle navigation</button>}</Show>
      </div>
    }
    function Fixture() {
      const dialog = useDialog()
      const [resourceRevision, setResourceRevision] = createSignal(1)
      if (location.search === "?navigator-remount") return <Show when={resourceRevision()} keyed>{() => <NavigatorProbe remount={() => setResourceRevision(value => value+1)} />}</Show>
      if (location.search === "?navigator-new-tab") return <div class="workbench-surface"><Show when={resourceRevision()} keyed>{revision => <NavigatorProbe navigationId={"file-navigation-" + revision} remount={() => setResourceRevision(value => value+1)} />}</Show></div>
      if (location.search === "?navigator-offset") return <div style="margin-left:700px;margin-top:96px;width:400px"><NavigatorProbe width="400px" /></div>
      if (location.search === "?navigator-nested") return <button onClick={() => dialog.push(() => <Dialog title="Workspace"><NavigatorProbe /></Dialog>)}>Open host</button>
      if (location.search === "?composed") return <div style="height:100dvh;display:flex;flex-direction:column">
        <DefaultShell context={{ shell: { render: part => part === "navigation" ?
          <div data-plugin-ui="synergy" style="display:contents"><aside class="sb-root sb-integrated sb-expanded" style="width:260px"><div class="sb-navigation"><button>Navigation</button></div></aside></div> : part === "route" ?
          <DefaultSession context={{ layout: { minimumWidth: () => 350, promptHeight: () => 120, render: view => view === "workbench.side" ? <WorkbenchSurface surface="side" /> : view === "conversation" ? <WorkspaceToggleProbe /> : view === "composer" ? <div style="position:absolute;bottom:0;left:0;right:0;z-index:50"><input aria-label="Composer draft" /></div> : null } }} /> : null }}} />
      </div>
      if (location.search && location.search !== "?restored") return <NavigatorProbe />
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
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "solid-js",
        "solid-js/web",
        "@lingui/core",
        "@lingui/solid",
        "lucide-solid",
        "@kobalte/core/dialog",
        "@kobalte/core/popover",
        "@kobalte/core/tooltip",
      ],
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
    retarget(): void
  }
}

async function openSurfaces() {
  errors.length = 0
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "Open bottom", exact: true }).click()
  await page.getByRole("button", { name: "bottom action" }).waitFor()
}

function captureWorkspaceFrames() {
  return page.evaluate(
    () =>
      new Promise<Array<{ left: number; right: number; width: number; controlLeft: number; collapseLeft: number }>>(
        (resolve) => {
          const frames: Array<{
            left: number
            right: number
            width: number
            controlLeft: number
            collapseLeft: number
          }> = []
          const started = performance.now()
          function capture() {
            const root = document.querySelector<HTMLElement>(".workbench-surface--side")!
            const bounds = root.getBoundingClientRect()
            const control = root.querySelector<HTMLElement>(".workbench-surface-controls [aria-pressed]")!
            const collapse = root.querySelector<HTMLElement>('[aria-label="Collapse workspace"]')!
            frames.push({
              left: bounds.left,
              right: bounds.right,
              width: bounds.width,
              controlLeft: control.getBoundingClientRect().left,
              collapseLeft: collapse.getBoundingClientRect().left,
            })
            if (performance.now() - started < 600) requestAnimationFrame(capture)
            else resolve(frames)
          }
          capture()
        },
      ),
  )
}

test("the closed workspace entry and open collapse control share the same bounds", async () => {
  await page.goto(baseUrl + "?composed")
  const opener = page.getByRole("button", { name: "Open side", exact: true })
  const closed = (await opener.boundingBox())!
  await opener.click()
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
  )
  const opened = (await page.getByRole("button", { name: "Collapse workspace", exact: true }).boundingBox())!
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(opened[key] - closed[key])).toBeLessThanOrEqual(1)
  }
  await page.getByRole("button", { name: "Collapse workspace", exact: true }).click()
  expect(await opener.boundingBox()).toEqual(closed)
  expect(errors).toEqual([])
})

test("opening a workspace keeps its collapse control at the right edge throughout the reveal", async () => {
  await page.goto(baseUrl + "?composed")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
  )
  const expected = (await page.getByRole("button", { name: "Collapse workspace", exact: true }).boundingBox())!.x
  await page.getByRole("button", { name: "Collapse workspace", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 0,
  )
  const recording = captureWorkspaceFrames()
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  const frames = await recording
  const revealed = frames.filter((frame) => frame.width >= 24)
  expect(revealed.some((frame) => frame.width < 144)).toBe(true)
  expect(Math.max(...revealed.map((frame) => Math.abs(frame.collapseLeft - expected)))).toBeLessThanOrEqual(1)
  expect(frames.every((frame) => Math.abs(frame.right - 1200) <= 1)).toBe(true)
  expect(errors).toEqual([])
})

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`fullscreen grows leftward with stationary controls and restores from the same edge with ${reducedMotion} motion`, async () => {
    await page.emulateMedia({ reducedMotion })
    await page.goto(baseUrl + "?composed")
    await page.getByRole("button", { name: "Open side", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
    )
    const expected = (await page.getByRole("button", { name: "Full screen", exact: true }).boundingBox())!.x
    const enterRecording = captureWorkspaceFrames()
    await page.getByRole("button", { name: "Full screen", exact: true }).click()
    const enter = await enterRecording
    expect(Math.max(...enter.map((frame) => Math.abs(frame.right - 1200)))).toBeLessThanOrEqual(1)
    expect(Math.max(...enter.map((frame) => Math.abs(frame.controlLeft - expected)))).toBeLessThanOrEqual(1)
    expect(enter.every((frame, index) => index === 0 || frame.left <= enter[index - 1].left + 1)).toBe(true)
    expect(enter.some((frame) => frame.width > 360 && frame.width < 1200)).toBe(reducedMotion === "no-preference")
    const exitRecording = captureWorkspaceFrames()
    await page.getByRole("button", { name: "Exit full screen", exact: true }).click()
    const exit = await exitRecording
    expect(Math.max(...exit.map((frame) => Math.abs(frame.right - 1200)))).toBeLessThanOrEqual(1)
    expect(Math.max(...exit.map((frame) => Math.abs(frame.controlLeft - expected)))).toBeLessThanOrEqual(1)
    expect(exit.every((frame, index) => index === 0 || frame.left >= exit[index - 1].left - 1)).toBe(true)
    expect(exit.at(-1)!.width).toBe(360)
    expect(errors).toEqual([])
  })
}

test("reversing fullscreen during expansion preserves the anchor, resource and preferred width", async () => {
  await page.goto(baseUrl + "?composed")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("textbox", { name: "side draft" }).fill("Retained during fullscreen reversal")
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
  )
  const bounds = (await page.getByRole("button", { name: "Full screen", exact: true }).boundingBox())!
  const recording = captureWorkspaceFrames()
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.waitForFunction(() => {
    const width = document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width
    return width > 360 && width < 1200
  })
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  const frames = await recording
  expect(Math.max(...frames.map((frame) => Math.abs(frame.right - 1200)))).toBeLessThanOrEqual(1)
  expect(Math.max(...frames.map((frame) => Math.abs(frame.controlLeft - bounds.x)))).toBeLessThanOrEqual(1)
  expect(Math.max(...frames.map((frame) => frame.width))).toBeGreaterThan(360)
  expect(Math.max(...frames.map((frame) => frame.width))).toBeLessThan(1200)
  expect(frames.at(-1)!.width).toBe(360)
  expect(await page.getByRole("button", { name: "Full screen", exact: true }).getAttribute("aria-pressed")).toBe(
    "false",
  )
  expect(await page.getByRole("textbox", { name: "side draft" }).inputValue()).toBe(
    "Retained during fullscreen reversal",
  )
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).mounts.side)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.size("side"))).toBe(360)
  expect(errors).toEqual([])
})

test("converting a tab to another resource type mounts the corresponding panel", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "side action", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.retarget())
  await page.getByRole("button", { name: "extra action", exact: true }).waitFor()
  expect(await page.getByRole("tab").count()).toBe(1)
  expect(await page.getByRole("button", { name: "side action", exact: true }).count()).toBe(0)
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`resource creation controls retain independent hover and menu states in ${colorScheme} mode`, async () => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
    await page.goto(baseUrl)
    await page.getByRole("button", { name: "Open side", exact: true }).click()
    const group = page.locator(".workbench-surface--side .workbench-surface-add-group")
    const add = group.getByRole("button", { name: "New tab", exact: true })
    const menu = group.getByRole("button", { name: "Open a resource", exact: true })
    const before = await group.boundingBox()
    const styles = () =>
      group.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        buttons: Array.from(element.querySelectorAll("button"), (button) => getComputedStyle(button).backgroundColor),
      }))
    await add.hover()
    const addHover = await styles()
    expect(addHover.background).not.toBe("rgba(0, 0, 0, 0)")
    expect(addHover.buttons[0]).not.toBe(addHover.background)
    expect(addHover.buttons[1]).toBe("rgba(0, 0, 0, 0)")
    await page.mouse.down()
    expect((await styles()).buttons[0]).not.toBe(addHover.buttons[0])
    await page.mouse.up()
    await menu.hover()
    const menuHover = await styles()
    expect(menuHover.background).toBe(addHover.background)
    expect(menuHover.buttons[0]).toBe("rgba(0, 0, 0, 0)")
    expect(menuHover.buttons[1]).toBe(addHover.buttons[0])
    expect(await group.boundingBox()).toEqual(before)
    await menu.click()
    await page.getByRole("menu").waitFor()
    await page.mouse.move(0, 0)
    await page.getByRole("menuitem", { name: "extra", exact: true }).focus()
    const menuOpen = await styles()
    expect(menuOpen.background).toBe(addHover.background)
    expect(menuOpen.buttons[1]).toBe(menuHover.buttons[1])
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open a resource")
    expect(await menu.evaluate((button) => getComputedStyle(button).outlineStyle)).toBe("solid")
    await page.keyboard.press("Shift+Tab")
    expect(await add.evaluate((button) => document.activeElement === button)).toBe(true)
    expect((await styles()).buttons[0]).not.toBe((await styles()).background)
    expect(await group.boundingBox()).toEqual(before)
    expect(errors).toEqual([])
  })
}

test("initializing restored tabs in a narrow window retains their identity without page errors", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?restored")
  expect(errors).toEqual([])
  await page.getByRole("button", { name: "side action", exact: true }).waitFor({ timeout: 5000 })
  expect(errors).toEqual([])
  expect(await page.getByRole("tab").count()).toBe(2)
  expect(await page.getByRole("tab", { name: "side", exact: true }).getAttribute("aria-selected")).toBe("true")
  expect((await page.locator(".workbench-surface--side").boundingBox())!.width).toBe(375)
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
  )
  expect(await page.getByRole("tab").count()).toBe(2)
  expect(errors).toEqual([])
})

test("selecting a file returns focus when its document controller remounts", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator-remount")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  await page.getByRole("button", { name: "Select document", exact: true }).click()
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor({ state: "hidden" })
  const trigger = page.getByRole("button", { name: "Toggle navigation", exact: true })
  expect(await trigger.isVisible()).toBe(true)
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-controls") === "file-navigation",
    undefined,
    { timeout: 2000 },
  )
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
})

test("opening another resource tab returns drawer focus to that tab's navigation", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator-new-tab")
  const previous = await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .getAttribute("aria-controls")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  await page.getByRole("button", { name: "Select document", exact: true }).click()
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor({ state: "hidden" })
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-controls") === "file-navigation-2",
    undefined,
    { timeout: 2000 },
  )
  expect(
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).getAttribute("aria-controls"),
  ).not.toBe(previous)
  expect(errors).toEqual([])
})

test("a navigation drawer stays within its resource content in split layout", async () => {
  await page.goto(baseUrl + "?navigator-offset")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await drawer.waitFor()
  await page.waitForFunction(() =>
    document
      .querySelector(".workspace-navigator-drawer")
      ?.getAnimations()
      .every((animation) => animation.playState === "finished"),
  )
  const bounds = await drawer.boundingBox()
  expect(bounds!.x).toBe(700)
  expect(bounds!.y).toBe(96)
  expect(bounds!.height).toBe(400)
  await page.keyboard.press("Escape")
  await drawer.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
  expect(errors).toEqual([])
})

test("fullscreen owns display and hit testing without discarding the composer", async () => {
  await page.goto(baseUrl + "?composed")
  await page.getByRole("textbox", { name: "Composer draft" }).fill("Keep this unsent draft")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  const fullscreen = page.getByRole("button", { name: "Full screen", exact: true })
  expect(await fullscreen.locator("svg.lucide-maximize-2").count()).toBe(1)
  await fullscreen.click()
  expect(await page.getByRole("textbox", { name: "Composer draft" }).isVisible()).toBe(false)
  expect(await page.getByRole("button", { name: "Navigation", exact: true }).isVisible()).toBe(false)
  expect((await page.locator(".sb-integrated").boundingBox())!.width).toBe(0)
  const tab = page.getByRole("tab", { name: "side", exact: true })
  await tab.click({ timeout: 2000 })
  const restore = page.getByRole("button", { name: "Exit full screen", exact: true })
  expect(await restore.locator("svg.lucide-minimize-2").count()).toBe(1)
  await restore.click()
  expect(await page.getByRole("textbox", { name: "Composer draft" }).inputValue()).toBe("Keep this unsent draft")
  expect(errors).toEqual([])
})

test("automatic expansion stays stable when hiding navigation changes the Session bounds", async () => {
  await page.goto(baseUrl + "?composed")
  await page.getByRole("textbox", { name: "Composer draft" }).fill("Retain this unsent draft")
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.setViewportSize({ width: 768, height: 900 })
  await page.waitForFunction(() =>
    document.querySelector(".workbench-surface--side")?.classList.contains("workbench-surface--overlay"),
  )
  await page.waitForFunction(
    () => Math.round(document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width) === 768,
  )
  const frames = await page.evaluate(
    () =>
      new Promise<Array<{ width: number; overlay: boolean }>>((resolve) => {
        const frames: Array<{ width: number; overlay: boolean }> = []
        function measure() {
          const pane = document.querySelector(".workbench-surface--side")!
          frames.push({
            width: Math.round(pane.getBoundingClientRect().width),
            overlay: pane.classList.contains("workbench-surface--overlay"),
          })
          if (frames.length < 20) requestAnimationFrame(measure)
          else resolve(frames)
        }
        requestAnimationFrame(measure)
      }),
  )
  expect(frames.every((frame) => frame.overlay && frame.width === 768)).toBe(true)
  expect(await page.getByRole("textbox", { name: "Composer draft" }).isVisible()).toBe(false)
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.waitForFunction(
    () => Math.round(document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width) === 360,
  )
  expect(await page.getByRole("button", { name: "Navigation", exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("textbox", { name: "Composer draft" }).inputValue()).toBe("Retain this unsent draft")
  expect(errors).toEqual([])
})

test("expanded resources respect the native titlebar safe area", async () => {
  await page.goto(baseUrl + "?composed")
  await page.evaluate(() => document.documentElement.style.setProperty("--workbench-native-inset", "88px"))
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.getByRole("button", { name: "Full screen", exact: true }).click()
  const tab = await page.getByRole("tab", { name: "side", exact: true }).boundingBox()
  expect(tab!.x).toBeGreaterThanOrEqual(88)
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

test("navigation disclosure announces actual visibility and uses one close owner", async () => {
  await page.setViewportSize({ width: 768, height: 900 })
  await page.goto(baseUrl + "?navigator")
  const trigger = page.getByRole("button", { name: "Toggle navigation", exact: true, includeHidden: true })
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  await page.setViewportSize({ width: 375, height: 900 })
  await page.getByRole("complementary").waitFor({ state: "detached" })
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.click()
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await page.goto(baseUrl + "?navigator-own-header")
  await trigger.click()
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Close navigation", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Close documents", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Toggle navigation")
})

test("resource menus support direction keys and return focus after Escape", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  const trigger = page.getByRole("button", { name: "Open a resource", exact: true })
  await trigger.click()
  await page.getByRole("menu").waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'))
  await page.keyboard.press("End")
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("extra")
  await page.keyboard.press("Home")
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("side")
  await page.keyboard.press("Escape")
  await page.getByRole("menu").waitFor({ state: "detached" })
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
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
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
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
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
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
