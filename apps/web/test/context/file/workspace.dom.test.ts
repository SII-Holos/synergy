import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".workspace-fixture-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    import { createStore } from "solid-js/store"
    export const a = { id: "wsp_a", generation: 1, scopeID: "scope", type: "directory", path: "/a" }
    export const b = { ...a, id: "wsp_b", path: "/b" }
    const [state, setState] = createStore({ session: { id: "session", workspace: { ...a } }, tabs: [], active: undefined })
    const requests = []; const pending = []; const listeners = new Set()
    const result = (query) => ({ data: { kind: "text", path: query.path, content: query.workspaceID || "wsp_a",
      node: { path: query.path, mtime: 1, size: 5, type: "file" }, encoding: "utf-8" } })
    export const useSDK = () => ({ scopeID: "scope", scopeKey: "scope", url: "http://server",
      client: { workspace: { files: { read(query) { requests.push(query); return new Promise(resolve => pending.push(() => resolve(result(query)))) },
        children: async () => ({ data: { children: [], truncated: false } }) } } },
      event: { listen(cb) { listeners.add(cb); return () => listeners.delete(cb) } } })
    export const useSync = () => ({ data: { path: { directory: "/a", workspace: a } }, session: { get: () => state.session } })
    export const useParams = () => ({ id: "session" })
    export const useWorkbenchPanels = () => ({ surface: () => ({ tabs: () => state.tabs, activeTab: () => state.active }),
      async openPanel(panelId, { init }) { const tab = { id: String(state.tabs.length), panelId, ...init }; setState("tabs", list => [...list, tab]); setState("active", tab); return tab },
      updateTab() {} })
    export const Persist = { workspace: () => ({}), scopeKey: (...args) => args.join(":"), scoped: () => ({}) }
    export const persisted = (_key, store) => [...store, undefined, () => true]
    window.fixture = { select(ws) { setState("session", "workspace", ws) }, a, b, requests, state,
      flush() { pending.splice(0).forEach(resolve => resolve()) },
      event(ws) { listeners.forEach(cb => cb({ details: { type: "file.watcher.updated", properties: {
        workspaceID: ws.id, workspaceGeneration: ws.generation, file: ws.path + "/same.txt", event: "changed" } } })) } }
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { FileProvider, useFile } from ${JSON.stringify(`/@fs/${appSrc}/context/file/index.tsx`)}
    function Probe() { const file = useFile(); window.fixture.file = file; return <output>{file.get("same.txt")?.content?.content || "empty"}</output> }
    render(() => <FileProvider><Probe /></FileProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "file-context-fixture",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            importer?.endsWith("/context/file/index.tsx") &&
            ["../sdk", "../sync", "../workbench", "@solidjs/router", "@/utils/persist"].includes(source)
          )
            return stubs
        },
      },
      solid(),
    ],
    resolve: { alias: { "@": appSrc } },
    optimizeDeps: { include: ["solid-js", "solid-js/web", "solid-js/store"], noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("switching Workspaces isolates late reads, cache entries, and watcher invalidation", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
    h.select(h.b)
  })
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.waitForFunction(() => document.querySelector("output")?.textContent !== "empty", undefined, {
    timeout: 5000,
  })
  expect(await page.locator("output").textContent()).toBe("wsp_b")
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.flush()
    h.select(h.a)
  })
  expect(await page.locator("output").textContent()).toBe("wsp_a")
  const requests = await page.evaluate(() =>
    (window as any).fixture.requests.map((q: { workspaceID: string }) => q.workspaceID),
  )
  expect(requests).toEqual(["wsp_a", "wsp_b"])
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.event({ ...h.a, generation: 2 })
  })
  expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(2)
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.event(h.b)
  })
  expect(
    await page.evaluate(() => (window as any).fixture.requests.map((q: { workspaceID: string }) => q.workspaceID)),
  ).toEqual(["wsp_a", "wsp_b", "wsp_b"])
  expect(errors).toEqual([])
}, 30_000)

test("a captured file handle retains its generation and null Workspace never selects the main directory", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    const original = h.file.load
    h.select({ ...h.a, generation: 2, path: "/rebound" })
    void original("same.txt")
    void h.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  expect(
    await page.evaluate(() =>
      (window as any).fixture.requests.map((q: { workspaceGeneration: number }) => q.workspaceGeneration),
    ),
  ).toEqual([1, 2])
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.select(null)
    void h.file.load("same.txt")
    void h.file.explorer.loadChildren()
  })
  expect(await page.locator("output").textContent()).toBe("empty")
  expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(2)
  expect(errors).toEqual([])
}, 30_000)
