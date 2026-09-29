import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

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
  await Bun.write(path.join(directory, "decision.tsx"), "export const SessionDecisionOutlet = () => null")
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
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
        render: part => part === "inbox" && !fresh() ? <div class="session-inbox-anchor"><button data-inbox style="width:36px;height:36px">Inbox</button></div> : null }
      return <div style="height:100dvh"><DefaultSession context={{layout: {
        minimumWidth: () => undefined, promptHeight: height,
        render: part => part === "composer" ? <PromptDock context={composer} /> : part === "conversation" ?
          <div class="flex-1 min-h-0"><Show when={fresh()} fallback={<div class="session-conversation-content session-content-column" data-message>Reply</div>}>
            <div class="session-empty-view"><div class="session-content-column">{greeting()}</div></div>
          </Show></div> : null,
      }}} /></div>
    }
    render(() => <App />, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind()],
    resolve: {
      alias: [
        { find: /^\.\/decision-surface$/, replacement: path.join(directory, "decision.tsx") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@solid-primitives/resize-observer", "zod"],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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
  await page.locator("[data-send]").waitFor()
  expect(errors).toEqual([])
}

async function bounds(selector: string) {
  return page.locator(selector).evaluate((element) => element.getBoundingClientRect().toJSON())
}

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

test("inbox remains within a narrow chat pane and touch actions retain their hit area", async () => {
  for (const width of [1440, 768, 375]) {
    await open(width, 812)
    await page.locator("[data-send]").click()
    const inbox = await bounds("[data-inbox]")
    expect(inbox.left).toBeGreaterThanOrEqual(0)
    expect(inbox.right).toBeLessThanOrEqual(width)
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
