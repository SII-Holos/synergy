import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixture: string
let baseURL: string
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".progress-fixture-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "runtime.ts"),
    `
    import { createSignal } from "solid-js"
    import { createStore } from "solid-js/store"
    import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
    const [status, setStatus] = createSignal({ type: new URLSearchParams(location.search).has("ended") ? "idle" : "busy" })
    const [connected, setConnected] = createSignal(true)
    const [waiting, setWaiting] = createSignal(false)
    const [data, setData] = createStore({
      session: [{ id: "s1" }], todo: { s1: [
        { id: "one", content: "Inspect the request interaction and preserve every word of this naturally wrapping long task", status: "in_progress", priority: "high" },
        { id: "two", content: "Write the regression test", status: "pending", priority: "medium" },
        { id: "three", content: "Retired item", status: "cancelled", priority: "low" },
      ] }, dag: { s1: [
        { id: "a", content: "Prepare the fixture", status: "running", deps: [], session_id: "child" },
        { id: "b", content: "Verify the result", status: "pending", deps: ["a"] },
      ] }, message: {}, part: {}, session_diff: {},
    })
    const runtime = { statusFor: () => status(), questionsFor: () => waiting() ? [{ id: "q", sessionID: "s1", questions: [] }] : [], permissionsFor: () => [] }
    export const useSessionDataView = () => () => createSessionDataView(data, runtime)
    export const useSDK = () => ({ connected })
    export const useSync = () => ({ ready: true })
    export const useLocale = () => ({ i18n: window.fixtureI18n })
    export const useNavigate = () => (url) => { window.navigation = url }
    export const useParams = () => ({ dir: "fixture" })
    window.changeProgress = (action) => {
      if (action === "idle" || action === "busy" || action === "paused") setStatus({ type: action })
      if (action === "disconnect") setConnected(false)
      if (action === "connect") setConnected(true)
      if (action === "wait") setWaiting(true)
      if (action === "answer") setWaiting(false)
      if (action === "failed") setData("dag", "s1", 0, "status", "failed")
      if (action === "large") setData("dag", "s1", Array.from({ length: 400 }, (_, i) => ({ id: "a" + i, content: "Task " + i, status: "pending", deps: i ? ["a" + (i - 1)] : [] })))
    }
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { SessionProgressPanel } from "@/components/session/session-progress-panel"
    import { SessionSurfaceFocusProvider } from "@/components/session/session-surface-focus"
    import { DagGraph } from "@ericsanchezok/synergy-ui/dag-graph"
    window.fixtureI18n = setupI18n({ locale: "en", messages: {} })
    render(() => <I18nProvider i18n={window.fixtureI18n}><MarkedProvider>
      <SessionSurfaceFocusProvider value={() => document.querySelector("#composer").focus()}>
        <div style={{ width: "100%", "max-width": "720px", margin: new URLSearchParams(location.search).has("nearTop") ? "48px auto 0" : "340px auto 0" }}>
          {new URLSearchParams(location.search).has("selectionOnly") ? <DagGraph nodes={[{ id: "select", content: "Select task", status: "pending", deps: [] }]} enableInspector={false} onSelectNode={(node) => { (window.selectedNodes ??= []).push(node.id) }} /> : <SessionProgressPanel sessionID="s1" />}
        </div>
        <textarea id="composer" aria-label="Composer" style={{ position: "relative", "z-index": 1, width: "100%", height: "160px" }} />
      </SessionSurfaceFocusProvider>
    </MarkedProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  const runtime = path.join(fixture, "runtime.ts")
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solid()],
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "solid-js/jsx-runtime",
        "@lingui/core",
        "@lingui/solid",
        "zod",
      ],
      noDiscovery: true,
    },
    resolve: {
      alias: Object.fromEntries([
        ...["locale", "sdk", "sync", "session-data-view"].map((name) => ["@/context/" + name, runtime]),
        ["@solidjs/router", runtime],
        ["@", path.resolve(import.meta.dir, "../../../src")],
      ]),
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  baseURL = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  page.setDefaultTimeout(8000)
  errors.length = 0
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseURL)
  await page.locator(".session-progress-island-header").waitFor()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})
afterEach(async () => {
  expect(errors).toEqual([])
  await page?.close()
})
const change = (action: string) =>
  page.evaluate((value) => (window as unknown as { changeProgress(value: string): void }).changeProgress(value), action)
const expand = () => page.locator(".session-progress-island-header").click()

test("progress stays inside a short viewport when a request pushes its anchor near the top", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?nearTop`)
  await expand()
  const panel = page.locator(".session-progress-island-panel")
  await page.waitForFunction(
    () => {
      const rect = document.querySelector(".session-progress-island-panel")?.getBoundingClientRect()
      return (
        rect &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        !!document
          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest(".session-progress-island-panel")
      )
    },
    undefined,
    { timeout: 4000 },
  )
  const bounds = (await panel.boundingBox())!
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(430)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
  expect(
    await panel.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return !!document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest(".session-progress-island-panel")
    }),
  ).toBe(true)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
})

test("selection-only consumers preserve click and keyboard selection without opening details", async () => {
  await page.goto(`${baseURL}?selectionOnly`)
  const node = page.getByRole("button", { name: "Task: Select task", exact: true })
  await node.click()
  await node.press("Enter")
  await node.press("Space")
  expect(await page.evaluate(() => (window as unknown as { selectedNodes: string[] }).selectedNodes)).toEqual([
    "select",
    "select",
    "select",
  ])
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
})

test("fixed summary and read-only Todo use current-view counts and complete wrapping", async () => {
  const before = await page.locator(".session-progress-island-header").boundingBox()
  await expand()
  const after = await page.locator(".session-progress-island-header").boundingBox()
  expect(after?.width).toBe(before?.width)
  expect(after?.height).toBe(before?.height)
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("0/2 complete · 1 cancelled")
  expect(await page.locator(".session-progress-todo-row").count()).toBe(3)
  expect(await page.locator(".session-progress-todo-row button, .session-progress-todo-row[role=button]").count()).toBe(
    0,
  )
  await page.getByRole("img", { name: "In progress", exact: true }).waitFor()
  expect(await page.getByRole("img", { name: "In progress", exact: true }).count()).toBe(1)
  expect(
    await page
      .locator(".session-progress-todo-content")
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace),
  ).toBe("pre-wrap")
  expect(errors).toEqual([])
})

test("DAG click and native keyboard share details; nested Escape restores node before collapsing progress", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  const node = page.getByRole("button", { name: "Task: Prepare the fixture", exact: true })
  await node.click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("true")
  expect(await node.evaluate((element) => element === document.activeElement)).toBe(true)
  await node.press("Space")
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await change("failed")
  expect(await page.locator('[data-slot="dag-node-preview-status"]').textContent()).toBe("FAILED")
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  await page.waitForFunction((node) => document.activeElement === node, await node.elementHandle())
  await page.keyboard.press("Escape")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  expect(await page.locator('[data-component="dag-graph"]').evaluate((node) => !!node.closest("[inert]"))).toBe(true)
  expect(errors).toEqual([])
})

test("DAG instance and manual viewport survive tab changes and collapse, with no hover details", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((node) => {
    ;(window as unknown as { graph: Element }).graph = node
  })
  const node = page.getByRole("button", { name: "Task: Prepare the fixture", exact: true })
  await node.hover()
  await page.clock.install()
  await page.clock.runFor(2500)
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
  const bounds = (await node.boundingBox())!
  await page.mouse.move(bounds.x + 40, bounds.y + 40)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 100, bounds.y + 80, { steps: 3 })
  await page.mouse.up()
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
  const transform = await page.locator('[data-slot="dag-graph-stage"]').getAttribute("style")
  await change("failed")
  await page.clock.runFor(300)
  expect(await page.locator('[data-slot="dag-graph-stage"]').getAttribute("style")).toBe(transform)
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  await expand()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((node) => node === (window as unknown as { graph: Element }).graph),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("failed execution ends while expanded and returns contained focus to Composer", async () => {
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await change("failed")
  await page.getByRole("button", { name: "Fit", exact: true }).focus()
  await change("idle")
  await page.clock.runFor(1500)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await page.clock.runFor(300)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((node) => node === document.activeElement),
  ).toBe(true)
})

test("waiting, paused and disconnect preserve progress; new activity cancels ending", async () => {
  await page.clock.install()
  await change("wait")
  await change("idle")
  await page.clock.runFor(2000)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("answer")
  await page.clock.runFor(900)
  await change("busy")
  await page.clock.runFor(2000)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("paused")
  await page.clock.runFor(2000)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("disconnect")
  await change("idle")
  await page.clock.runFor(2000)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("connect")
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("initially ended sessions do not flash a progress summary", async () => {
  await page.goto(baseURL + "?ended")
  await page.getByRole("textbox", { name: "Composer" }).waitFor()
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("large DAG retains its instance and closes inspector when switching views", async () => {
  await change("large")
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-slot="dag-graph-node-action"]').first().waitFor({ state: "attached" })
  expect(await page.locator('[data-slot="dag-graph-node-action"]').count()).toBe(400)
  await page.locator('[data-component="dag-graph"]').evaluate((node) => {
    ;(window as unknown as { largeGraph: Element }).largeGraph = node
  })
  await page.locator('[data-slot="dag-graph-node-action"]').first().focus()
  await page.keyboard.press("Enter")
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((node) => node === (window as unknown as { largeGraph: Element }).largeGraph),
  ).toBe(true)
  expect(await page.locator('[data-slot="dag-graph-stats"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("reduced motion hides an ended receipt without a fade", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.clock.install()
  await change("idle")
  await page.clock.runFor(1601)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})
