import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

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
    export const surface = { tabs: () => state[task()].tabs, active: () => state[task()].active,
      setTabs: tabs => setState(task(), "tabs", tabs), setActive: active => setState(task(), "active", active), opened: () => false }
    window.switchTask = id => setTask(id)
    export const useWorkbenchPanels = () => ({ sessionKey: task, surface: () => surface })
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
      <div role="tablist"><For each={surface.tabs()}>{tab => <button role="tab" aria-selected={surface.active() === tab.id}>{tab.id}</button>}</For></div>
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
        "./browser-ws": path.join(directory, "transport.ts"),
        "@": source,
      },
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "zod"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
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

test("one Scope catalog reconciles across task switches without changing human selection", async () => {
  await page.goto(url)
  await page.waitForFunction(() => typeof (window as unknown as Fixture).completeSnapshot === "function")
  await page.evaluate(() =>
    (window as unknown as Fixture).completeSnapshot({
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
    }),
  )
  await page.getByRole("tab", { name: /shared/ }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).switchTask("two"))
  await page.getByRole("tab", { name: "two-file", exact: true }).waitFor()
  expect(await page.getByRole("tab").count()).toBe(2)
  expect(await page.getByRole("tab", { name: "two-file", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.evaluate(() => (window as unknown as Fixture).deliverPages([]))
  await page.getByRole("tab", { name: /shared/ }).waitFor({ state: "hidden" })
  await page.evaluate(() => (window as unknown as Fixture).switchTask("one"))
  await page.getByRole("tab", { name: "file", exact: true }).waitFor()
  expect(await page.getByRole("tab").allTextContents()).toEqual(["file"])
})
