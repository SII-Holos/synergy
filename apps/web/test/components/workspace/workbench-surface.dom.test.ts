import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let context: BrowserContext
let page: Page
let server: BrowserFixture
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
        {id === "side" && new URLSearchParams(location.search).has("workspace-navigation") ? window.navigationPanel() : <><button>{id} action</button><input aria-label={id + " draft"} /></>}
      </div> }
    }))
    const states = Object.fromEntries(["side", "bottom"].map(id => {
      const restored = id === "side" && location.search === "?restored"
      const [opened, setOpened] = createSignal(restored)
      const [size, setSize] = createSignal(id === "side" ? 360 : 200)
      const [fullscreen, setFullscreen] = createSignal(false)
      const [tabs, setTabs] = createSignal(restored ? [{ id, panelId: id }, {id:"restored-extra",panelId:"extra"}] : [{ id, panelId: id }])
      const [active, setActive] = createSignal(id)
      return [id, { opened, setOpened, close: () => setOpened(false), toggle: () => setOpened(!opened()), size, setSize, tabs, setTabs,
        fullscreen, setFullscreen, activeTab: () => tabs().find(tab => tab.id === active()), active, setActive }]
    }))
    window.fixture = { retarget: () => states.side.setTabs([{id:"side",panelId:"extra"}]), open: id => states[id].setOpened(true), close: id => states[id].close(), crash: setCrash, resize: (id,size) => states[id].setSize(size), size: id => states[id].size(), populate: () => states.side.setTabs(Array.from({length:20}, (_,i) => ({ id: i ? 'tab-'+i : 'side', panelId:'side', title: 'Long document title ' + i }))) }
    export const useWorkbenchPanels = () => ({
      surface: id => states[id], panels: () => entries, panelForTab: tab => entries.find(x => x.id === tab?.panelId),
      interact() {}, activateTab(name, id) { states[name].setActive(id) }, getPanel: id => entries.find(entry => entry.id === id),
      panelTitle: tab => tab.title ?? tab.panelId, openPanel: () => {}, closeTab: () => {}, closeOtherTabs: () => {}, moveTab: () => {}
    })
    const hasSidebar = () => location.search === "?composed" || (location.search === "?toolbar" && innerWidth >= 768)
    export const useLayout = () => ({ isDesktop: () => true, sidebar: { opened: hasSidebar, width: () => 260, occupiedWidth: () => hasSidebar() ? 260 : 0 }, nav: { recentEntries: () => [], rootNavEntries: () => [], projectNavEntries: () => [] }, scopes: { list: () => [] }, mobileSidebar: { toggle() {} }, rightSidebar: { toggle() {} } })
  `,
  )
  await Bun.write(
    path.join(directory, "topbar-services.ts"),
    `
    import { useLingui } from "@lingui/solid"
    export const useLocale = () => ({ i18n: useLingui().i18n() })
    export const useGlobalSDK = () => ({ client: {}, capabilities: { has: () => false } })
    export const useSDK = () => ({ connected: () => true, client: {} })
    export const useExecution = () => ({ available: () => false, state: {} })
    export const useLocal = () => ({ agent: { current: () => ({}) }, model: {
      current: () => ({ name: "Fixture model" }),
      variant: { list: () => ["high"], displayed: () => undefined, set() {} },
      selection: { saving: () => false, state: () => undefined, error: () => undefined, retry() {} }
    } })
    export const useCommand = () => ({ options: [], keybind: () => undefined, trigger() {} })
    export const useSync = () => ({ data: { workspaces: [], inbox: {}, session: [], message: {}, part: {} }, session: { get: () => ({ id: "fixture", title: "Toolbar fixture", scope: { id: "home" }, tags: [] }) } })
    export const useSessionDataView = () => () => ({ statusFor: () => ({ type: "idle" }), messagesFor: () => [], inboxFor: () => [] })
    `,
  )
  await Bun.write(
    path.join(directory, "topbar-dialogs.tsx"),
    `
    export const DialogSessionRename = () => null
    export const DialogSessionExport = () => null
    export const DialogSessionImport = () => null
    export const WorktreeEnterConfirmDialog = () => null
    export const ModelSelectorPopover = props => props.triggerAs({})
    export const useConfirm = () => ({ show() {} })
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
    import { Popover } from "@ericsanchezok/synergy-ui/popover"
    import { MobileWorkspaceDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/mobile-workspace-dialog.tsx`)}
    import { WorkbenchSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/workbench-surface.tsx`)}
    import { WorkspaceNavigator } from ${JSON.stringify(`/@fs/${source}/components/workspace/workspace-navigator.tsx`)}
    import { DefaultSession } from ${JSON.stringify(`/@fs/${source}/plugin/default-session.tsx`)}
    import { DefaultShell } from ${JSON.stringify(`/@fs/${source}/plugin/default-shell.tsx`)}
    import { SessionTopBar } from ${JSON.stringify(`/@fs/${source}/components/top-bar/session-top-bar.tsx`)}
    import { SessionWorkbenchChrome } from ${JSON.stringify(`/@fs/${source}/components/session/workbench-chrome.ts`)}
    import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
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
      const dialog = useDialog()
      const [open, setOpen] = createSignal(true)
      const [revision, setRevision] = createSignal(1)
      const [navigation, setNavigation] = createSignal()
      return <div data-ui-part="resource-panel" style={{width:props.width ?? "100vw",height:"448px",display:"flex","flex-direction":"column"}}>
        <div style="height:48px;flex-shrink:0">
          <Show when={revision()} keyed>{() => <button data-workspace-navigation-toggle aria-controls={navigation()?.id} aria-expanded={navigation()?.opened()} onClick={() => navigation()?.toggle()}>Toggle navigation</button>}</Show>
        </div>
        <div data-workspace-fixture-content style="position:relative;display:flex;flex:1;min-height:0">
        <WorkspaceNavigator id={props.navigationId ?? (props.remount ? "file-navigation" : undefined)} label="Documents" header={location.search !== "?navigator-own-header"} open={open()} width={320} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onResize={() => {}} onReady={setNavigation}>
          <button onClick={() => {setRevision(value => value+1); props.remount?.(); navigation()?.closeDrawer()}}>Select document</button>
          {location.search === "?navigator-own-header" && <button onClick={() => navigation()?.closeDrawer()}>Close documents</button>}
          {(location.search === "?navigator-layers" || props.layers) && <>
            <Popover title="Navigation options" triggerAs={props => <button {...props}>Options</button>}><button>Option action</button></Popover>
            <button onClick={() => dialog.push(() => <Dialog title="File action"><button>Confirm action</button></Dialog>)}>Open file action</button>
          </>}
        </WorkspaceNavigator>
        <input aria-label="Document draft" style="min-width:0;flex:1" />
        </div>
      </div>
    }
    window.navigationPanel = () => <NavigatorProbe width="100%" layers />
    function Fixture() {
      const dialog = useDialog()
      const [mobileOpen, setMobileOpen] = createSignal(false)
      if (new URLSearchParams(location.search).has("modal")) return <>
        <button onClick={() => { window.fixture.open("side"); setMobileOpen(true) }}>Open modal workspace</button>
        <Show when={mobileOpen()}>
          <MobileWorkspaceDialog onClose={() => { window.fixture.close("side"); setMobileOpen(false) }}>
            <WorkbenchSurface surface="side" modalHost />
          </MobileWorkspaceDialog>
        </Show>
      </>

      const [resourceRevision, setResourceRevision] = createSignal(1)
      if (location.search === "?navigator-remount") return <Show when={resourceRevision()} keyed>{() => <NavigatorProbe remount={() => setResourceRevision(value => value+1)} />}</Show>
      if (location.search === "?navigator-new-tab") return <div class="workbench-surface"><Show when={resourceRevision()} keyed>{revision => <NavigatorProbe navigationId={"file-navigation-" + revision} remount={() => setResourceRevision(value => value+1)} />}</Show></div>
      if (location.search === "?navigator-offset") return <><input aria-label="Conversation draft" style="position:absolute;left:40px;top:160px" /><div style="margin-left:700px;margin-top:96px;width:400px"><NavigatorProbe width="400px" /></div></>
      if (location.search === "?navigator-nested") return <button onClick={() => dialog.push(() => <Dialog title="Workspace"><NavigatorProbe /></Dialog>)}>Open host</button>
      if (location.search === "?toolbar") {
        const history = createMemoryHistory()
        history.set({ value: "/aG9tZQ/session/fixture" })
        return <MemoryRouter history={history}><Route path="/:dir/session/:id" component={() => <div style="height:100dvh"><DefaultShell context={{ shell: { render: part => part === "navigation" && innerWidth >= 768 ? <aside class="sb-root sb-integrated sb-expanded" style="width:260px" /> : part === "route" ? <DefaultSession context={{ layout: { minimumWidth: () => 350, promptHeight: () => 120, render: view => view === "workbench.side" ? <WorkbenchSurface surface="side" /> : view === "conversation" ? <><SessionTopBar /><button>Conversation action</button></> : view === "composer" ? <input aria-label="Composer draft" /> : null } }} /> : null } }} /></div>} /></MemoryRouter>
      }
      if (location.search === "?composed") return <div style="height:100dvh;display:flex;flex-direction:column">
        <DefaultShell context={{ shell: { render: part => part === "navigation" ?
          <div data-plugin-ui="synergy" style="display:contents"><aside class="sb-root sb-integrated sb-expanded" style="width:260px"><div class="sb-navigation"><button>Navigation</button></div></aside></div> : part === "route" ?
          <DefaultSession context={{ layout: { minimumWidth: () => 350, promptHeight: () => 120, render: view => view === "workbench.side" ? <WorkbenchSurface surface="side" /> : view === "conversation" ? <WorkspaceToggleProbe /> : view === "composer" ? <div style="position:absolute;bottom:0;left:0;right:0;z-index:50"><input aria-label="Composer draft" /></div> : null } }} /> : null }}} />
      </div>
      if (location.search && location.search !== "?restored" && location.search !== "?workspace-navigation") return <NavigatorProbe />
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
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: /^@\/context\/(workbench|layout)$/, replacement: path.join(directory, "state.tsx") },
      {
        find: /^@\/context\/(global-sdk|sdk|execution|local|command|sync|session-data-view|locale)$/,
        replacement: path.join(directory, "topbar-services.ts"),
      },
      { find: /^@\/components\/dialog$/, replacement: path.join(directory, "topbar-dialogs.tsx") },
      {
        find: /^@\/components\/dialog\/dialog-session-(export|import)$/,
        replacement: path.join(directory, "topbar-dialogs.tsx"),
      },
      {
        find: "@/components/session/worktree-transition-dialog",
        replacement: path.join(directory, "topbar-dialogs.tsx"),
      },
      { find: "@", replacement: source },
    ],
  })
  baseUrl = server.url
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  errors.length = 0
  context = await browser.newContext({ viewport: { width: 1200, height: 1000 } })
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
})

afterEach(async () => {
  if (errors.length) console.error(errors)
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

for (const colorScheme of ["light", "dark"] as const) {
  test(`closed session actions keep equal spacing to the workspace entry in ${colorScheme} mode`, async () => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(baseUrl + "?toolbar")
      await page.waitForFunction(() => Boolean((window as unknown as WorkbenchWindow).fixture))
      expect(errors).toEqual([])
      const row = page.locator(".stb-desktop .stb-right .stb-icon-btn")
      await row.first().waitFor()
      const buttons = await row.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON()),
      )
      const opener = (await page.locator(".session-workbench-controls button").boundingBox())!
      expect(opener.x - buttons.at(-1)!.right).toBe(8)
      for (let index = 1; index < buttons.length; index++) {
        expect(buttons[index].left - buttons[index - 1].right).toBe(8)
      }
      expect(buttons.every((button) => button.width === 32 && button.height === 32)).toBe(true)
      expect(opener.width).toBe(32)
      expect(opener.height).toBe(32)
      expect(errors).toEqual([])
    }
  })
}

test("session toolbar glyphs keep their compact size when the workspace opens and closes", async () => {
  await page.goto(baseUrl + "?toolbar")
  await page.waitForFunction(() => Boolean((window as unknown as WorkbenchWindow).fixture))
  expect(errors).toEqual([])
  const opener = page.locator(".session-workbench-controls button")
  await opener.waitFor()
  const entry = (await opener.boundingBox())!
  const glyph = (await opener.locator("svg").boundingBox())!
  const headerIcons = await page
    .locator(".stb-desktop .stb-icon-btn svg")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))
  expect(headerIcons.every((icon) => icon.width === 16 && icon.height === 16)).toBe(true)
  expect(glyph.width).toBe(16)
  expect(glyph.height).toBe(16)
  await opener.focus()
  await page.keyboard.press("Enter")
  const collapse = page.getByRole("button", { name: "Collapse workspace", exact: true })
  await collapse.waitFor()
  await page.waitForFunction(
    () => document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width === 360,
  )
  const expanded = (await collapse.boundingBox())!
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(expanded[key] - entry[key])).toBeLessThanOrEqual(1)
  }
  const expandedGlyph = (await collapse.locator("svg").boundingBox())!
  expect(expandedGlyph.width).toBe(glyph.width)
  expect(expandedGlyph.height).toBe(glyph.height)
  for (const key of ["x", "y"] as const) {
    expect(Math.abs(expandedGlyph[key] - glyph[key])).toBeLessThanOrEqual(1)
  }
  await collapse.focus()
  await page.keyboard.press("Enter")
  await opener.waitFor()
  expect(await opener.boundingBox()).toEqual(entry)
  expect(await opener.locator("svg").boundingBox()).toEqual(glyph)
  expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
})

test("mobile session toolbar keeps compact glyphs and reachable controls", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(baseUrl + "?toolbar")
  await page.waitForFunction(() => Boolean((window as unknown as WorkbenchWindow).fixture))
  expect(errors).toEqual([])
  const buttons = page.locator(".stb-root .md\\:hidden .stb-icon-btn")
  await buttons.first().waitFor()
  const bounds = await buttons.evaluateAll((elements) =>
    elements.map((element) => ({
      button: element.getBoundingClientRect().toJSON(),
      icon: element.querySelector("svg")!.getBoundingClientRect().toJSON(),
    })),
  )
  expect(bounds.length).toBeGreaterThanOrEqual(3)
  expect(
    bounds.every(
      ({ button, icon }) =>
        button.width >= 32 &&
        button.height >= 32 &&
        button.left >= 0 &&
        button.right <= 375 &&
        icon.width === 16 &&
        icon.height === 16,
    ),
  ).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test("workspace controls preserve their bounds while closed, open, and throughout the reveal", async () => {
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
  const expected = opened.x
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
  expect(bounds!.y).toBe(144)
  expect(bounds!.height).toBe(400)
  await page.keyboard.press("Escape")
  await drawer.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
  expect(errors).toEqual([])
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`narrow navigation only covers resource content and leaves the conversation usable in ${colorScheme} mode`, async () => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
    await page.goto(baseUrl + "?navigator-offset")
    const content = page.locator("[data-workspace-fixture-content]")
    const contentBounds = await content.boundingBox()
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
    const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
    await drawer.waitFor()
    const backdrop = page.locator(".workspace-navigator-overlay")
    expect(await backdrop.boundingBox()).toEqual(contentBounds)
    expect(await backdrop.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none")
    const conversation = page.getByRole("textbox", { name: "Conversation draft", exact: true })
    expect(await conversation.isVisible()).toBe(true)
    await conversation.click({ timeout: 2000 })
    await drawer.waitFor({ state: "detached" })
    await conversation.fill("Continue the conversation")
    expect(await conversation.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  })
}

test("a navigation disclosure closes its open drawer without reopening on the same click", async () => {
  await page.goto(baseUrl + "?navigator-offset")
  const trigger = page.getByRole("button", { name: "Toggle navigation", exact: true })
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await trigger.click()
  await drawer.waitFor()
  await trigger.click({ timeout: 2000 })
  await drawer.waitFor({ state: "detached" })
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.press("Enter")
  await drawer.waitFor()
  await page.keyboard.press("Escape")
  await drawer.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
  expect(errors).toEqual([])
})

test("the resource backdrop dismisses navigation without focusing the covered document", async () => {
  await page.goto(baseUrl + "?navigator-offset")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await drawer.waitFor()
  const backdrop = page.locator(".workspace-navigator-overlay")
  const bounds = (await backdrop.boundingBox())!
  await page.mouse.click(bounds.x + bounds.width - 8, bounds.y + 80)
  await drawer.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
  expect(await page.getByRole("textbox", { name: "Document draft" }).inputValue()).toBe("")
  expect(errors).toEqual([])
})

test("navigation remains behind its own menu and file dialog until they are dismissed", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator-layers")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await drawer.waitFor()
  await page.getByRole("button", { name: "Options", exact: true }).click()
  const option = page.getByRole("button", { name: "Option action", exact: true })
  await option.focus()
  await page.keyboard.press("Escape")
  await option.waitFor({ state: "detached" })
  expect(await drawer.count()).toBe(1)
  await page.getByRole("button", { name: "Open file action", exact: true }).click()
  const action = page.getByRole("dialog", { name: "File action", exact: true })
  await action.waitFor()
  await page.keyboard.press("Escape")
  await action.waitFor({ state: "detached" })
  await drawer.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent === "Open file action")
  await page.keyboard.press("Escape")
  await drawer.waitFor({ state: "detached" })
  expect(errors).toEqual([])
})

test("navigation follows its content bounds and restores the preferred width at the drawer threshold", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(baseUrl + "?navigator-offset")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  await page.getByRole("dialog", { name: "Documents", exact: true }).waitFor()
  const resource = page.locator('[data-ui-part="resource-panel"]')
  await resource.evaluate((element) => {
    const resource = element as HTMLElement
    resource.style.width = "519px"
    resource.style.height = "300px"
    resource.parentElement!.style.transform = "translateX(-80px)"
  })
  const content = page.locator("[data-workspace-fixture-content]")
  expect(await page.locator(".workspace-navigator-overlay").boundingBox()).toEqual(await content.boundingBox())
  expect((await page.locator(".workspace-navigator-drawer").boundingBox())!.height).toBe(252)
  await resource.evaluate((element) => ((element as HTMLElement).style.width = "520px"))
  const navigation = page.getByRole("complementary", { name: "Documents", exact: true })
  await navigation.waitFor()
  expect(await page.getByRole("dialog", { name: "Documents", exact: true }).count()).toBe(0)
  expect((await navigation.boundingBox())!.width).toBe(240)
  await resource.evaluate((element) => ((element as HTMLElement).style.width = "800px"))
  await page.waitForFunction(
    () => document.querySelector(".workspace-navigator")!.getBoundingClientRect().width === 320,
  )
  expect((await navigation.boundingBox())!.width).toBe(320)
  expect(errors).toEqual([])
})

for (const width of [375, 1200]) {
  test(`the real workspace yields Escape to a resource menu and navigation before closing at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(baseUrl + "?workspace-navigation")
    await page.getByRole("button", { name: "Open side", exact: true }).click()
    const workspace = page.locator(".workbench-surface--side")
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
    const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
    await drawer.waitFor()
    await page.getByRole("button", { name: "Options", exact: true }).click()
    const option = page.getByRole("button", { name: "Option action", exact: true })
    await option.focus()
    await page.keyboard.press("Escape")
    await option.waitFor({ state: "detached" })
    expect(await drawer.isVisible()).toBe(true)
    expect(await workspace.getAttribute("aria-hidden")).toBe("false")
    await page.keyboard.press("Escape")
    await drawer.waitFor({ state: "detached" })
    expect(await workspace.getAttribute("aria-hidden")).toBe("false")
    await page.waitForFunction(() => document.activeElement?.textContent === "Toggle navigation")
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      () => document.querySelector(".workbench-surface--side")!.getAttribute("aria-hidden") === "true",
    )
    expect(errors).toEqual([])
  })
}

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
  await page.waitForFunction(() => document.activeElement?.closest("[data-workspace-navigation]"))
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

test("leaving document navigation with Tab preserves the enclosing mobile workspace focus boundary", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl + "?navigator-nested")
  await page.getByRole("button", { name: "Open host", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Workspace", exact: true })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close dialog")
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).evaluate((element) => {
    ;(element as HTMLButtonElement).click()
    const choice = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-workspace-navigation] button")).find(
      (button) => button.textContent === "Select document",
    )
    choice?.focus()
  })
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await drawer.waitFor()
  await drawer.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Select document")
  await page.keyboard.press("Tab")
  await drawer.waitFor({ state: "detached" })
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"]')?.contains(document.activeElement),
    undefined,
    { timeout: 2000 },
  )
  expect(await host.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await host.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open host")
  expect(errors).toEqual([])
})

test("the automatic workspace overlay contains keyboard focus and restores the preferred width", async () => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open side", exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.populate())
  const selected = page.getByRole("tab", { name: "Long document title 1", exact: true })
  await selected.click()
  const panel = page.locator(".workbench-surface--side")
  await panel.getByRole("textbox", { name: "side draft" }).focus()
  await page.keyboard.press("Tab")
  expect(await selected.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Shift+Tab")
  expect(
    await panel.getByRole("textbox", { name: "side draft" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.waitForFunction(() => !document.querySelector(".workbench-surface--side")?.hasAttribute("aria-modal"))
  await page.waitForFunction(
    () => Math.round(document.querySelector(".workbench-surface--side")!.getBoundingClientRect().width) === 360,
  )
  expect(Math.round((await panel.boundingBox())!.width)).toBe(360)
}, 30000)

test("leaving navigation skips hidden menu anchors in the real mobile workspace", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${baseUrl}?modal&workspace-navigation`)
  await page.getByRole("button", { name: "Open modal workspace", exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkbenchWindow).fixture.populate())
  const selected = page.getByRole("tab", { name: "Long document title 1", exact: true })
  await selected.click()
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Documents", exact: true })
  await drawer.waitFor()
  await page.getByRole("button", { name: "Open file action", exact: true }).focus()
  await page.keyboard.press("Tab")
  await drawer.waitFor({ state: "detached" })
  expect(await selected.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Workspace", exact: true }).waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open modal workspace")
  expect(errors).toEqual([])
})

test("modal workspace stays accessible and focusable below the dock width limit", async () => {
  errors.length = 0
  try {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${baseUrl}?modal`)
    await page.getByRole("button", { name: "Open modal workspace", exact: true }).click()
    const modal = page.getByRole("dialog", { name: "Workspace", exact: true })
    await modal.getByRole("button", { name: "side action", exact: true }).waitFor({ timeout: 3000 })
    await modal.getByRole("textbox", { name: "side draft" }).fill("modal draft")
    await page.setViewportSize({ width: 320, height: 568 })
    const surface = modal.locator(".workbench-surface")
    expect(await surface.getAttribute("aria-hidden")).toBe("false")
    expect(await surface.getAttribute("inert")).toBeNull()
    expect(await surface.getByRole("separator").count()).toBe(0)
    expect(await modal.getByRole("textbox", { name: "side draft" }).inputValue()).toBe("modal draft")
    await modal.getByRole("button", { name: "side action", exact: true }).focus()
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("side action")
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(i < 3 ? "Tab" : "Shift+Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press("Escape")
    await modal.waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.textContent === "Open modal workspace")
    expect(errors).toEqual([])
  } finally {
    await page.setViewportSize({ width: 1200, height: 1000 })
  }
}, 20000)
