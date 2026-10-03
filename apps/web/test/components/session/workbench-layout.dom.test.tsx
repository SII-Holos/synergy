import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".workbench-layout-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `export const usePlatform = () => ({ platform: "desktop", desktopWindow: { chrome: "native" } })`,
  )
  await Bun.write(path.join(directory, "decision.tsx"), "export const SessionDecisionOutlet = () => null")
  await Bun.write(
    path.join(directory, "execution.ts"),
    `export const useExecution = () => ({ available: () => false, state: {} });
     export const useParams = () => ({ id: "fixture" })`,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { TaskDetailsPopover } from ${JSON.stringify(`/@fs/${source}/components/execution/popover.tsx`)}
    import { SidebarNavigation } from  ${JSON.stringify(`/@fs/${source}/components/sidebar/sidebar-navigation.tsx`)}
    import  ${JSON.stringify(`/@fs/${source}/components/sidebar/sidebar.css`)}
    import { DefaultShell } from ${JSON.stringify(`/@fs/${source}/plugin/default-shell.tsx`)}
    import { DesktopNativeTitlebar } from ${JSON.stringify(`/@fs/${source}/components/app-shell/desktop-native-titlebar.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/components/top-bar/session-top-bar.css`)}
    import { DefaultSession } from ${JSON.stringify(`/@fs/${source}/plugin/default-session.tsx`)}
    import { PromptDock } from ${JSON.stringify(`/@fs/${source}/components/session/prompt-dock.tsx`)}
    import { createPromptDockHeight } from ${JSON.stringify(`/@fs/${source}/components/session/prompt-dock-height.ts`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/session/session-inbox.css`)}
    function App() {
      const [fresh, setFresh] = createSignal(true)
      const [height, setHeight] = createSignal(0)
      const dock = createPromptDockHeight(setHeight)
      const input = {
        readOnly: () => false, primaryAction: () => "send", submit: async () => setFresh(false),
        dragging: () => false, className: () => "", current: () => ({ mode: "normal" }),
        setComposing: () => {}, dragOver: () => {}, dragLeave: () => {}, drop: async () => {},
        editor: { label: () => "Message", completion: () => undefined, placeholder: () => undefined,
          mount: () => () => {}, beforeInput: () => {}, input: () => {}, paste: async () => {}, keyDown: () => {} },
        render: part => part === "toolbar" ? <div class="prompt-input-toolbar"><button class="prompt-input-submit" type="submit" data-send>Send</button></div> : null,
      }
      const greeting = () => <div data-greeting>Start a task</div>
      const composer = { input: () => input, mount: dock.mount, ready: () => true, isNewSession: fresh,
        readOnly: () => false, isGlobal: () => true, pendingText: () => "", scopeName: () => "Home",
        branch: () => undefined, lastModified: () => undefined, links: () => [],
        render: part => part === "status" ? <button data-status>Connection details</button> : null }
      return <div style="height:100dvh"><DefaultSession context={{layout: {
        minimumWidth: () => undefined, promptHeight: height,
        render: part => part === "composer" ? <PromptDock context={composer} /> : part === "conversation" ?
          <div class="flex-1 min-h-0"><Show when={!fresh()}><header class="stb-root" style="justify-content:flex-end"><div class="stb-right"><TaskDetailsPopover inboxCount={1} inbox={() => <div class="session-inbox-list"><div class="session-inbox-row" data-inbox>Queued follow-up</div></div>} /></div></header></Show><Show when={fresh()} fallback={<div class="session-conversation-content session-content-column" data-message>Reply</div>}>
            <div class="session-empty-view"><div class="session-content-column">{greeting()}</div></div>
          </Show></div> : null,
      }}} /></div>
    }
    function ChromeFixture() {
      const query = new URLSearchParams(location.search)
      const [collapsed, setCollapsed] = createSignal(false)
      const [custom, setCustom] = createSignal(false)
      const route = () => <><div class="stb-root"><div class="stb-left"><button class="stb-selector-btn">Model</button></div><button>Panel</button></div><div data-ui-part="conversation" /></>
      return <div class="app-shell app-shell--desktop-native-chrome" classList={{ "app-shell--sidebar-collapsed": collapsed() }} style="height:100dvh;display:flex;flex-direction:column;--desktop-native-titlebar-traffic-width:90px">
        <DesktopNativeTitlebar />
        <Show when={!custom()} fallback={<div data-custom>Third-party Shell</div>}>
          <DefaultShell context={{shell: {render: part => part === "navigation" ? <aside class="sb-root sb-integrated" classList={{"sb-collapsed":collapsed()}} style={{width: collapsed() ? "0px" : "260px", "flex-shrink": 0}}><SidebarNavigation expanded={!collapsed()} labels={{expand:"Expand",collapse:"Collapse",search:"Search",newSession:"New task"}} onToggle={() => setCollapsed(!collapsed())} onSearch={()=>{}} onNew={()=>{}}><span class="sb-logo">Brand</span></SidebarNavigation></aside> : part === "route" ? route() : null}}} />
        </Show>
        <button data-shell-switch onClick={() => setCustom(true)} style="position:fixed;bottom:0;right:0">Switch Shell</button>
      </div>
    }
    const i18n = setupI18n({ locale: "en", messages: { en: {} } })
    render(() => <I18nProvider i18n={i18n}>{new URLSearchParams(location.search).has("chrome") ? <ChromeFixture /> : <App />}</I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind(), ...lingui()],
    resolve: {
      alias: [
        { find: /^\.\/decision-surface$/, replacement: path.join(directory, "decision.tsx") },
        { find: "@/context/platform", replacement: path.join(directory, "platform.ts") },
        { find: "@/context/execution", replacement: path.join(directory, "execution.ts") },
        { find: "@solidjs/router", replacement: path.join(directory, "execution.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/jsx-runtime",
        "@solid-primitives/resize-observer",
        "@lingui/core",
        "@lingui/solid",
        "fuzzysort",
        "zod",
      ],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(width = 1440, height = 900) {
  errors.length = 0
  await page.setViewportSize({ width, height })
  await page.goto(url)
  await page
    .locator("[data-send]")
    .waitFor({ timeout: 5000 })
    .catch((error) => {
      throw new AggregateError(
        [error, ...errors.map((message) => new Error(message))],
        "Workbench fixture did not mount",
      )
    })
  expect(errors).toEqual([])
}

async function bounds(selector: string) {
  return page.locator(selector).evaluate((element) => element.getBoundingClientRect().toJSON())
}

test("new and existing tasks keep input actions without a reserved status footer", async () => {
  await open()
  expect(await page.locator("[data-status]").count()).toBe(0)
  expect(await page.locator("[data-send]").isVisible()).toBe(true)
  await page.locator("[data-send]").click()
  expect(await page.locator("[data-status]").count()).toBe(0)
  expect(await page.locator("[data-send]").isVisible()).toBe(true)
  const dock = await bounds(".session-prompt-dock-content")
  const input = await bounds(".prompt-input-shell")
  expect(Math.abs(dock.bottom - input.bottom)).toBeLessThanOrEqual(1)
}, 30_000)

test("first send keeps the composer anchored and the editor mounted", async () => {
  await open()
  await page.locator('[role="textbox"]').fill("Unsent draft")
  const before = await bounds(".prompt-input-shell")
  expect(before.bottom).toBeGreaterThan(810)
  expect(await page.locator("[data-greeting]").count()).toBe(1)
  await page.locator("[data-send]").click()
  await page.waitForTimeout(450)
  const after = await bounds(".prompt-input-shell")
  expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(1)
  expect(await page.locator('[role="textbox"]').innerText()).toBe("Unsent draft")
  const content = await bounds(".session-conversation-content")
  const column = await bounds(".session-prompt-dock-content")
  expect(Math.abs(content.left - column.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(content.width - column.width)).toBeLessThanOrEqual(1)
  expect(await page.locator('[role="textbox"]').count()).toBe(1)
}, 20_000)

test("task details contain the inbox on narrow panes and touch actions retain their hit area", async () => {
  for (const width of [1440, 768, 375]) {
    await open(width, 812)
    await page.locator("[data-send]").click()
    await page.getByRole("button", { name: "Task details", exact: true }).click()
    await page.locator(".execution-inbox-entry").click()
    await page.locator("[data-inbox]").waitFor()
    const popover = await bounds(".execution-popover")
    const inbox = await bounds("[data-inbox]")
    expect(popover.left).toBeGreaterThanOrEqual(0)
    expect(popover.right).toBeLessThanOrEqual(width)
    expect(inbox.left).toBeGreaterThanOrEqual(popover.left)
    expect(inbox.right).toBeLessThanOrEqual(popover.right)
    await page.locator(".execution-inbox-back").click()
    expect(await page.locator(".execution-inbox-entry").evaluate((element) => element === document.activeElement)).toBe(
      true,
    )
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.classList.contains("execution-trigger"))
    if (width === 375) {
      const send = await bounds("[data-send]")
      expect(send.width).toBeGreaterThanOrEqual(44)
      expect(send.height).toBeGreaterThanOrEqual(44)
    }
  }
}, 20_000)

test("long input grows upward and keeps actions in a short or narrow viewport", async () => {
  for (const size of [
    { width: 1024, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await open(size.width, size.height)
    const before = await bounds(".prompt-input-shell")
    await page
      .locator('[role="textbox"]')
      .fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: a long synthetic draft`).join("\n"))
    const after = await bounds(".prompt-input-shell")
    const action = await bounds("[data-send]")
    expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(1)
    expect(after.top).toBeGreaterThan(60)
    expect(action.bottom).toBeLessThanOrEqual(size.height)
    expect(action.left).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const editor = await page.locator('[role="textbox"]').evaluate((element) => {
      const scroller = element.parentElement!
      return { height: scroller.clientHeight, scroll: scroller.scrollHeight }
    })
    expect(editor.height).toBeLessThanOrEqual(Math.min(240, size.height * 0.4))
    expect(editor.scroll).toBeGreaterThan(editor.height)
  }
}, 20_000)

test("native host controls share the built-in row and retain third-party Shell space", async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(url + "?chrome")
  for (const collapsed of [false, true]) {
    if (collapsed) await page.locator("[data-sidebar-toggle]").click()
    await page.locator(".stb-root").waitFor()
    const native = await bounds(".desktop-native-titlebar")
    const header = await bounds(".stb-root")
    const model = await bounds(".stb-selector-btn")
    const toggle = await bounds("[data-sidebar-toggle]")
    expect(native.height).toBe(48)
    expect(native.top).toBe(header.top)
    expect(model.left).toBeGreaterThanOrEqual(native.right)
    expect(toggle.left).toBeGreaterThanOrEqual(native.right)
    expect(toggle.top).toBeLessThan(native.bottom)
    await page.waitForFunction(
      (width) => Math.abs(document.querySelector(".sb-root")!.getBoundingClientRect().width - width) < 0.01,
      collapsed ? 0 : 260,
    )
    expect((await bounds(".sb-root")).width).toBe(collapsed ? 0 : 260)
    expect(await page.locator(".sb-logo").isVisible()).toBe(false)
    expect(
      await page.locator(".stb-selector-btn").evaluate((el) => getComputedStyle(el).getPropertyValue("app-region")),
    ).toBe("no-drag")
  }
  await page
    .locator(".app-shell")
    .evaluate((el) => (el as HTMLElement).style.setProperty("--desktop-native-titlebar-traffic-width", "0px"))
  expect((await bounds("[data-sidebar-toggle]")).left).toBeLessThan(20)
  expect((await bounds(".desktop-native-titlebar")).width).toBe(0)
  await page.locator("[data-shell-switch]").click()
  await page.locator("[data-custom]").waitFor({ state: "attached", timeout: 2000 })
  expect((await bounds("[data-custom]")).top).toBe((await bounds(".desktop-native-titlebar")).bottom)
}, 20_000)
