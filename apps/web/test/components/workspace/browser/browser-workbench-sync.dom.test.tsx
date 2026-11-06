import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-workbench-sync-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    export const useSDK = () => ({ url: "http://fixture.test", scopeID: "home", client: { browser: {
      session: () => new Promise(resolve => { window.completeSnapshot = resolve })
    } } })
  `,
  )
  await Bun.write(
    path.join(directory, "workbench.ts"),
    `
    import { createSignal } from "solid-js"
    import { createStore } from "solid-js/store"
    const [task, setTask] = createSignal("one")
    const [state, setState] = createStore({
      one: { tabs: [{ id: "file", panelId: "file" }, { id: "old", panelId: "browser", resourceId: "old" }], active: "file" },
      two: { tabs: [{ id: "two-file", panelId: "file" }], active: "two-file" }
    })
    export const surface = { tabs: () => state[task()].tabs, savedTabs: () => state[task()].tabs, hasOpening: () => false, active: () => state[task()].active,
      setTabs: tabs => setState(task(), "tabs", tabs), setActive: active => setState(task(), "active", active), opened: () => false }
    window.switchTask = id => setTask(id)
    export const useParams = () => ({ get id() { return task() } })
    export const useWorkbenchPanels = () => ({ sessionKey: task, surface: () => surface, openingForTab: () => undefined })
  `,
  )
  await Bun.write(
    path.join(directory, "transport.ts"),
    `
    export const createBrowserWebSocket = store => { window.deliverPages = pages => store.replacePages(pages) }
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { For, Suspense } from "solid-js"
    import { surface } from "./workbench"
    import { BrowserCatalogProvider } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-catalog.tsx`)}
    import { BrowserWorkbenchSync } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-sync.tsx`)}
    window.openPage = id => {
      surface.setTabs(tabs => [...tabs, { id, panelId: "browser", resourceId: id }])
      surface.setActive(id)
    }
    render(() => <BrowserCatalogProvider><>
      <div role="tablist"><For each={surface.tabs()}>{tab => <button role="tab" title={tab.title} aria-selected={surface.active() === tab.id}>{tab.id}</button>}</For></div>
      <Suspense><BrowserWorkbenchSync route={{mode:"scope",scopeID:"home",path_directory:"home"}} /></Suspense>
    </></BrowserCatalogProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@/context/sdk": path.join(directory, "sdk.ts"),
        "@/context/workbench": path.join(directory, "workbench.ts"),
        "@/context/session-route": path.join(directory, "workbench.ts"),
        "./browser-ws": path.join(directory, "transport.ts"),
        "@": source,
      },
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "zod"] },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(source, "../../..")] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Fixture = Window & {
  completeSnapshot(value: unknown): void
  openPage(id: string): void
  deliverPages(pages: unknown[]): void
  switchTask(id: string): void
}

test("catalog synchronization retains the requested title before the document commits", async () => {
  await page.goto(url)
  await page.waitForFunction(() => typeof (window as unknown as Fixture).completeSnapshot === "function")
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.openPage("loading")
    fixture.completeSnapshot({
      data: {
        pages: [
          {
            id: "loading",
            profileId: "personal",
            title: "",
            url: "about:blank",
            status: "active",
            isLoading: true,
            lastActiveAt: null,
            navigation: {
              id: "navigation",
              generation: 1,
              revision: 1,
              requestedURL: "https://example.com/slow",
              phase: "loading",
              slow: false,
            },
          },
        ],
        seq: 1,
        epoch: "one",
        ownerKey: "owner-one",
      },
    })
  })
  await page.getByRole("tab", { name: "old", exact: true }).waitFor({ state: "hidden" })
  expect(await page.getByRole("tab", { name: "loading", exact: true }).getAttribute("title")).toBe("example.com")
})

test("Agent-created pages reconcile silently on bootstrap, task switching and navigation", async () => {
  await page.goto(url)
  await page.waitForFunction(() => typeof (window as unknown as Fixture).completeSnapshot === "function")
  const pages = ["one", "two"].map((sessionID) => ({
    id: `agent-${sessionID}`,
    profileId: "personal",
    title: sessionID,
    url: "about:blank",
    createdBySessionID: sessionID,
    status: "active",
    isLoading: false,
    lastActiveAt: null,
  }))
  await page.evaluate(
    (pages) =>
      (window as unknown as Fixture).completeSnapshot({ data: { pages, seq: 1, epoch: "one", ownerKey: "owner-one" } }),
    pages,
  )
  await page.getByRole("tab", { name: /agent-one/ }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file", expect.stringContaining("agent-one")])
  expect(await page.getByRole("tab", { name: "file", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() => (window as unknown as Fixture).switchTask("two"))
  await page.getByRole("tab", { name: /agent-two/ }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["two-file", expect.stringContaining("agent-two")])
  await page.getByRole("tab", { name: "two-file", exact: true }).focus()
  await page.evaluate(
    (pages) => (window as unknown as Fixture).deliverPages(pages),
    pages.map((item) => ({ ...item, title: "Navigated", url: "https://example.com/new" })),
  )
  await page.locator('[role="tab"][title="Navigated"]').waitFor()
  expect(await page.getByRole("tab", { name: "two-file", exact: true }).getAttribute("aria-selected")).toBe("true")
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("two-file")
})

test("a held bootstrap removes stale tabs but preserves a page opened after its request", async () => {
  await page.goto(url)
  await page.waitForFunction(() => typeof (window as unknown as Fixture).completeSnapshot === "function")
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.openPage("new")
    fixture.completeSnapshot({ data: { pages: [], seq: 1, epoch: "one", ownerKey: "owner-one" } })
  })
  await page.getByRole("tab", { name: "old", exact: true }).waitFor({ state: "hidden" })
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file", "new"])
  expect(await page.getByRole("tab", { name: "new", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() => {
    ;(window as unknown as Fixture).deliverPages([
      {
        id: "new",
        profileId: "personal",
        title: "New",
        url: "about:blank",
        status: "active",
        isLoading: false,
        lastActiveAt: null,
      },
    ])
  })
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file", "new"])
  await page.evaluate(() => (window as unknown as Fixture).deliverPages([]))
  await page.getByRole("tab", { name: "new", exact: true }).waitFor({ state: "hidden" })
  expect(await page.getByRole("tab", { name: "file", exact: true }).getAttribute("aria-selected")).toBe("true")
})

test("one Scope catalog preserves independent task tabs through updates and task switches", async () => {
  await page.goto(url)
  await page.waitForFunction(() => typeof (window as unknown as Fixture).completeSnapshot === "function")
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.openPage("shared")
    fixture.completeSnapshot({
      data: {
        pages: [
          {
            id: "shared",
            profileId: "personal",
            title: "Shared",
            url: "about:blank",
            status: "active",
            isLoading: false,
            lastActiveAt: null,
          },
        ],
        seq: 1,
        epoch: "one",
        ownerKey: "owner-one",
      },
    })
  })
  await page.getByRole("tab", { name: /shared/ }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).switchTask("two"))
  await page.getByRole("tab", { name: "two-file", exact: true }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["two-file"])
  expect(await page.getByRole("tab", { name: "two-file", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.openPage("two")
    fixture.deliverPages([
      { id: "shared", title: "Updated", url: "https://example.com" },
      { id: "two", title: "Second", url: "https://example.org" },
      { id: "popup", openerId: "shared", title: "Popup", url: "https://example.com/login" },
    ])
  })
  expect(await page.getByRole("tab").allTextContents()).toEqual(["two-file", "two"])
  expect(await page.getByRole("tab", { name: "two", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() => (window as unknown as Fixture).switchTask("one"))
  await page.getByRole("tab", { name: "file", exact: true }).waitFor()
  await page.getByRole("tab", { name: /popup/ }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file", "shared", expect.stringContaining(":popup")])
  expect(await page.getByRole("tab", { name: "shared", exact: true }).getAttribute("title")).toBe("Updated")
  expect(await page.getByRole("tab", { name: "shared", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() =>
    (window as unknown as Fixture).deliverPages([
      { id: "two", title: "Second", url: "https://example.org" },
      { id: "popup", openerId: "shared", title: "Popup", url: "https://example.com/login" },
    ]),
  )
  await page.getByRole("tab", { name: "shared", exact: true }).waitFor({ state: "hidden" })
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file", expect.stringContaining(":popup")])
  await page.evaluate(() => (window as unknown as Fixture).switchTask("two"))
  await page.getByRole("tab", { name: "two-file", exact: true }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["two-file", "two"])
})
