import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
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
    const [permission, setPermission] = createSignal(false)
    const [offer, setOffer] = createSignal(false)
    const [editing, setEditing] = createSignal(false)
    const [cancelFailure, setCancelFailure] = createSignal(false)
    const [currentSession, setCurrentSession] = createSignal("s1")
    export { offer, editing, currentSession }
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
    const [tasks, setTasks] = createStore([
      { id: "task-a", sessionID: "child", parentSessionID: "s1", agent: "coding", description: "Prepare the fixture", status: "running", startedAt: Date.now() - 1000 },
      { id: "task-q", sessionID: "queued", parentSessionID: "s1", agent: "general", description: "Queued task", status: "queued", startedAt: Date.now() },
      { id: "other-task", sessionID: "other", parentSessionID: "other-parent", agent: "general", description: "Other session", status: "running", startedAt: Date.now() },
    ])
    window.navigation = []
    window.cancellations = []
    const runtime = { statusFor: () => status(), cortexTasks: () => tasks, questionsFor: (id) => waiting() && id === "child" ? [{ id: "q", sessionID: "child", questions: [] }] : [], permissionsFor: (id) => permission() && id === "child" ? [{ id: "p", sessionID: "child" }] : [] }
    export const useSessionDataView = () => () => createSessionDataView(data, runtime)
    export const useSDK = () => ({ connected, client: { cortex: { cancel: async ({ taskID }) => { window.cancellations.push(taskID); if (cancelFailure()) throw new Error("Temporary cancellation failure"); return { data: true } } } } })
    export const useSync = () => ({ ready: true })
    export const useLocale = () => ({ i18n: window.fixtureI18n })
    export const useNavigate = () => (url) => { window.navigation = url }
    export const useNavigateToSession = () => (id) => { window.navigation.push(id) }
    export const useParams = () => ({ dir: "fixture" })
    window.changeProgress = (action) => {
      if (action === "idle" || action === "busy" || action === "paused") setStatus({ type: action })
      if (action === "disconnect") setConnected(false)
      if (action === "connect") setConnected(true)
      if (action === "wait") setWaiting(true)
      if (action === "answer") setWaiting(false)
      if (action === "permission") setPermission(true)
      if (action === "allow") setPermission(false)
      if (action === "offer") setOffer(true)
      if (action === "dismiss-offer") setOffer(false)
      if (action === "expand-editor") setEditing(true)
      if (action === "collapse-editor") setEditing(false)
      if (action === "cancel-failure") setCancelFailure(true)
      if (action === "cancel-success") setCancelFailure(false)
      if (action === "child-ended") setTasks(0, "status", "completed")
      if (action === "switch-session") setCurrentSession("other-parent")
      if (action === "unknown") setStatus(undefined)
      if (action === "many") setTasks(Array.from({ length: 30 }, (_, i) => ({ ...tasks[0], id: "task-" + i, sessionID: "child-" + i, startedAt: Date.now() + i })))
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
    import { PromptDockFloatLayer } from "@/components/session/prompt-dock-float-layer"
    import { offer, editing, currentSession } from "./runtime"
    import { SessionSurfaceFocusProvider } from "@/components/session/session-surface-focus"
    import { DagGraph } from "@ericsanchezok/synergy-ui/dag-graph"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
    import { Dialog } from "@kobalte/core/dialog"
    import { Toast } from "@ericsanchezok/synergy-ui/toast"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    window.fixtureI18n = setupI18n({ locale: "en", messages: {} })
    render(() => <I18nProvider i18n={window.fixtureI18n}><ThemeProvider><MarkedProvider>
      <SessionSurfaceFocusProvider value={() => document.querySelector("#composer").focus()}>
        {new URLSearchParams(location.search).has("existingModal") ? <Dialog open><Dialog.Content aria-label="Existing modal"><button>Existing modal action</button></Dialog.Content></Dialog> : null}
        <div class="session-prompt-dock-content" style={{ position: "relative", width: "100%", "max-width": "720px", margin: new URLSearchParams(location.search).has("compressed") ? "48px auto 0" : new URLSearchParams(location.search).has("limitedDag") ? "240px auto 0" : new URLSearchParams(location.search).has("nearTop") ? "140px auto 0" : "420px auto 0" }}>
          {new URLSearchParams(location.search).has("selectionOnly") ? <DagGraph nodes={[{ id: "select", content: "Select task", status: "pending", deps: [] }]} enableInspector={false} onSelectNode={(node) => { (window.selectedNodes ??= []).push(node.id) }} /> : <PromptDockFloatLayer sessionID={currentSession()} priorityControl={offer() ? <button data-offer>Review workflow</button> : undefined} />}
          <textarea id="composer" class="session-composer" data-expanded={editing() ? "" : undefined} aria-label="Composer" style={{ position: "relative", "z-index": 1, width: "100%", height: "160px" }} />
        </div>
        <Toast.Region />
      </SessionSurfaceFocusProvider>
    </MarkedProvider></ThemeProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  const runtime = path.join(fixture, "runtime.ts")
  server = await createBrowserFixture({
    root: fixture,
    styled: true,
    aliases: [
      ...["locale", "sdk", "sync", "session-data-view"].map((name) => ["@/context/" + name, runtime]),
      ["@/composables/use-navigate-to-session", runtime],
      ["@solidjs/router", runtime],
      ["@", path.resolve(import.meta.dir, "../../../src")],
    ].map(([find, replacement]) => ({ find, replacement })),
  })
  baseURL = server.url
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  page.setDefaultTimeout(8000)
  errors.length = 0
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseURL)
  await page.locator("#composer").waitFor()
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

test("the bottom dock mounts current agents and expandable Todo and DAG", async () => {
  await page.locator(".subagent-dock-avatar").first().waitFor()
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  await expand()
  expect(await page.locator(".session-progress-todo-row").count()).toBe(3)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).waitFor()
})

const navigation = () => page.evaluate(() => (window as unknown as { navigation: string[] }).navigation)
const cancellations = () => page.evaluate(() => (window as unknown as { cancellations: string[] }).cancellations)
const avatar = () => page.locator(".subagent-dock-avatar").first()
async function holdPointer() {
  const box = (await avatar().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

test("short activation opens the child while queued agents remain waiting", async () => {
  await avatar().click()
  await avatar().press("Enter")
  await avatar().press("Space")
  await page.locator(".subagent-dock-avatar").last().dispatchEvent("click")
  expect(await navigation()).toEqual(["child", "child", "child"])
  expect(await cancellations()).toEqual([])
})

test("pointer and keyboard holds cancel once without also opening the child", async () => {
  await page.clock.install()
  await holdPointer()
  await page.clock.runFor(2100)
  await page.mouse.up()
  await avatar().press("Enter")
  await page.clock.runFor(2100)
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
  expect(await avatar().getAttribute("aria-busy")).toBe("true")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  await change("child-ended")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(1)
  await page.reload()
  await avatar().focus()
  await page.keyboard.down("Space")
  await page.clock.runFor(2100)
  await page.keyboard.up("Space")
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
})

test("movement, pointer cancellation, blur and Escape abort hold activation", async () => {
  await page.clock.install()
  await holdPointer()
  await page.mouse.move(10, 10, { steps: 4 })
  await page.clock.runFor(2200)
  await page.mouse.up()
  await holdPointer()
  await avatar().dispatchEvent("pointercancel", { pointerId: 1 })
  await page.clock.runFor(2200)
  await page.mouse.up()
  await holdPointer()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await page.clock.runFor(2200)
  await page.mouse.up()
  await avatar().focus()
  await page.keyboard.down("Space")
  await page.keyboard.press("Escape")
  await page.clock.runFor(2200)
  await page.keyboard.up("Space")
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
  await avatar().click()
  expect(await navigation()).toEqual(["child"])
})

test("expanded editing aborts a hold and retains the collapsed graph and pending cancellation", async () => {
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { retained: Element }).retained = element
  })
  await holdPointer()
  await change("expand-editor")
  await page.clock.runFor(2200)
  await page.mouse.up()
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
  expect(await avatar().isVisible()).toBe(false)
  expect(await page.locator(".session-progress-island-header").isVisible()).toBe(false)
  await change("collapse-editor")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await expand()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { retained: Element }).retained),
  ).toBe(true)
  await holdPointer()
  await page.clock.runFor(2100)
  await page.mouse.up()
  await change("expand-editor")
  await change("collapse-editor")
  expect(await avatar().getAttribute("aria-busy")).toBe("true")
  await avatar().press("Enter")
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
})

test("secondary pointer cancellation cannot interrupt the initiating hold", async () => {
  await page.clock.install()
  await holdPointer()
  await avatar().dispatchEvent("pointercancel", { pointerId: 2, pointerType: "touch", isPrimary: false })
  await avatar().dispatchEvent("lostpointercapture", { pointerId: 2, pointerType: "touch", isPrimary: false })
  await page.clock.runFor(2100)
  await page.mouse.up()
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
})

test("failed cancellation explains the error and permits another attempt", async () => {
  await change("cancel-failure")
  await holdPointer()
  await page.waitForTimeout(2100)
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.getByText("Could not cancel agent", { exact: true }).waitFor()
  expect(await avatar().getAttribute("aria-busy")).toBe("false")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  expect(await navigation()).toEqual([])
  await change("cancel-success")
  await holdPointer()
  await page.waitForTimeout(2100)
  await page.mouse.up()
  expect(await cancellations()).toEqual(["task-a", "task-a"])
})

test("changing session during a hold discards the old gesture", async () => {
  await page.clock.install()
  await holdPointer()
  await change("switch-session")
  await page.clock.runFor(2200)
  await page.mouse.up()
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(1)
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
})

test("many agents remain reachable without horizontal page overflow", async () => {
  await page.setViewportSize({ width: 320, height: 700 })
  await change("many")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(30)
  await page.locator(".subagent-dock-avatar").last().focus()
  await page.keyboard.press("Enter")
  expect(await navigation()).toEqual(["child-29"])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("workflow priority hides progress and freezes its retained DAG without removing avatars", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { retained: Element }).retained = element
  })
  await page.getByRole("button", { name: "Fit", exact: true }).focus()
  await change("offer")
  expect(await page.locator("[data-offer]").isVisible()).toBe(true)
  expect(await page.locator(".session-progress-island-header").isVisible()).toBe(false)
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await change("dismiss-offer")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await expand()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { retained: Element }).retained),
  ).toBe(true)
})

test("child permissions and unknown status preserve an observed progress receipt", async () => {
  await page.clock.install()
  await change("permission")
  await change("idle")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("allow")
  await page.clock.runFor(1000)
  await change("unknown")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("idle")
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("compressed space opens a readable progress dialog and restores focus on close", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?compressed`)
  await expand()
  const dialog = page.getByRole("dialog", { name: "Session progress", exact: true })
  await dialog.waitFor()
  await page.waitForFunction(() => document.activeElement?.classList.contains("session-progress-island-close"))
  const box = (await dialog.boundingBox())!
  expect(box.height).toBeGreaterThan(150)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(430)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  expect(await dialog.isVisible()).toBe(true)
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { compactGraph: Element }).compactGraph = element
  })
  await page.getByRole("button", { name: "Close progress", exact: true }).click()
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await page.waitForFunction(() => document.activeElement?.classList.contains("session-progress-island-header"))
  await expand()
  await dialog.waitFor()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { compactGraph: Element }).compactGraph),
  ).toBe(true)
  const zoom = await page.context().newCDPSession(page)
  await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
  await page.waitForFunction(() => {
    const rect = document.querySelector('.session-progress-island-panel[data-expanded="true"]')?.getBoundingClientRect()
    const viewport = window.visualViewport!
    return rect && rect.top >= viewport.offsetTop && rect.bottom <= viewport.offsetTop + viewport.height
  })
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(2)
  await page.waitForFunction(() => {
    const graph = document.querySelector('[data-component="dag-graph"]')!.getBoundingClientRect()
    const body = document.querySelector(".session-progress-island-body")!.getBoundingClientRect()
    return graph.top >= body.top && graph.bottom <= body.bottom
  })
  await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 })
})

test("an ending progress dialog releases its focus boundary to Composer", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?compressed`)
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "Close progress", exact: true }).focus()
  await change("idle")
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test("collapsed progress cannot suspend an existing modal focus boundary", async () => {
  await page.goto(`${baseURL}?existingModal`)
  const action = page.getByRole("button", { name: "Existing modal action", exact: true })
  await action.focus()
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("dialog", { name: "Existing modal", exact: true })
      .evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true)
})

test("a constrained DAG keeps the active task visible in the actual reading body", async () => {
  await page.goto(`${baseURL}?limitedDag`)
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  const nodes = page.locator('[data-slot="dag-graph-node-action"]')
  await nodes.first().waitFor()
  expect(await nodes.count()).toBe(2)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-slot="dag-graph-node-action"]')].some((element) => {
      if (element.getAttribute("aria-label") !== "Task: Prepare the fixture") return false
      const rect = element.getBoundingClientRect()
      const body = element.closest(".session-progress-island-body")!.getBoundingClientRect()
      return (
        rect.top >= body.top &&
        rect.bottom <= body.bottom &&
        document
          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest('[data-slot="dag-graph-node-action"]') === element
      )
    }),
  )
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
})

test("progress stays inside a short viewport when a request pushes its anchor near the top", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?nearTop`)
  await expand()
  const panel = page.locator(".session-progress-island-panel")
  await page.waitForFunction(
    () => {
      const rect = document.querySelector(".session-progress-island-panel")?.getBoundingClientRect()
      return rect && rect.top >= 0 && rect.bottom <= innerHeight
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
  await page.waitForFunction((element) => element === document.activeElement, await node.elementHandle())
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
