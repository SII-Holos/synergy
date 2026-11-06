import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { FileEntryClipboard, useFile, useProjectFiles } from "../../../src/context/file"

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
    const [state, setState] = createStore({ session: { id: "session", workspace: { ...a } }, tabs: [], active: undefined, visible: true, secondVisible: false })
    const statuses = []; const pendingStatuses = []
    const entryState = { hold: false, signal: undefined, outcome: undefined }
    const childPages = {}; const childRequests = []; const heldDirectories = []; const pendingDirectories = []; const childFailures = []
    const requests = []; const writes = []; const entries = []; const disk = {}; const pending = []; const listeners = new Set(); const writeState = { mode: "conflict", finish: undefined }
    const result = (query) => ({ data: { kind: "text", path: query.path, content: disk[query.workspaceID]?.content ?? query.workspaceID ?? "wsp_a",
      contentVersion: disk[query.workspaceID]?.version ?? "sha256:" + "a".repeat(64),
      node: { path: query.path, mtime: 1, size: 5, type: "file" }, encoding: "utf-8" } })
    export const useSDK = () => ({ scopeID: "scope", scopeKey: "scope", url: "http://server",
      client: { workspace: { files: { read(query) { requests.push(query); if (disk[query.workspaceID]?.missing) return Promise.reject({ name: "NotFoundError", data: { message: "file missing" } }); const response = result(query); return new Promise(resolve => pending.push(() => resolve(response))) },
        async write(query) { writes.push(query);
          if (writeState.mode === "conflict") throw { name: "WorkspaceFileWriteConflictError", data: { message: "changed" } }
          await new Promise(resolve => writeState.finish = resolve)
          const body = query.workspaceFileWriteFileInput
          disk[query.workspaceID] = { content: body.content, version: "sha256:" + "c".repeat(64) }
          return { data: { contentVersion: disk[query.workspaceID].version, mtime: 2, size: body.content.length, path: body.path, existed: true } }
        },
        createDirectory: async (query, options) => { entries.push(query); entryState.signal = options.signal; if(entryState.hold) await new Promise((resolve,reject)=> { entryState.finish=resolve; options.signal.addEventListener("abort",()=>reject(new DOMException("Operation aborted","AbortError")),{once:true}) }); return { data: { path: "created", node: { path: "created", type: "directory" } } } },
        copy: async (query) => { entries.push(query); return { data: { path: query.workspaceFileCopyInput.to, node: {} } } },
        move: async (query) => { entries.push(query); return { data: { path: query.workspaceFileMoveInput.to, node: {} } } },
        remove: async (query) => { entries.push(query); return { data: { removed: true, path: query.workspaceFileDeleteInput.path } } },
        status(query) { statuses.push(query); return new Promise(resolve => pendingStatuses.push(() => resolve({ data: { files: [] } }))) },
        async children(query) {
          childRequests.push(query)
          if (heldDirectories.includes(query.path)) await new Promise(resolve => pendingDirectories.push(resolve))
          if (childFailures.includes(query.path)) throw new Error("Folder is unreadable")
          return { data: childPages[query.path + (query.cursor ? "|" + query.cursor : "")] ?? { children: [], truncated: false } }
        } } } },
      event: { listen(cb) { listeners.add(cb); return () => listeners.delete(cb) } } })
    export const useSync = () => ({ data: { workspaces: [{id:"wsp_objects",scopeID:"scope",type:"objects",binding:{state:"bound",path:null,generation:1},backend:{provider:"objects"},metadata:{name:"Research"},lifecycle:"active"}], path: { directory: "/a", workspace: a } }, session: { get: () => state.session } })
    export const useParams = () => ({ id: "session" })
    export const useDialog = () => ({ push() {}, close() {} })
    export const useLocale = () => ({ i18n: { _: value => value.message } })
    export const useWorkbenchPanels = () => ({ surface: () => ({ tabs: () => state.tabs, activeTab: () => state.active, selectionRevision: () => 0 }),
      async openPanel(panelId, { init }) { const tab = { id: String(state.tabs.length), panelId, ...init }; setState("tabs", list => [...list, tab]); setState("active", tab); return tab },
      updateTab() {} })
    export const Persist = { workspace: (owner, key) => ({ storage: "fixture:" + owner, key }), scopeKey: (...args) => args.join(":"), scoped: () => ({}) }
    export const persisted = (_key, store) => [...store, undefined, () => true]
    window.fixture = { select(ws) { setState("session", "workspace", ws) }, a, b, requests, writes, entries, entryState, disk, state, writeState, statuses,
      childPages, childRequests, heldDirectories, childFailures, flushDirectories() { pendingDirectories.splice(0).forEach(resolve => resolve()) },
      visible(value) { setState("visible", value) },
      switchConsumer() { setState("visible", false); setState("secondVisible", true) },
      flushStatuses() { pendingStatuses.splice(0).forEach(resolve => resolve()) },
      selectObjects() { setState("session", {workspace: null,workspaceID:"wsp_objects"}) },
      emit(properties) { listeners.forEach(cb => cb({ details: { type: "file.watcher.updated", properties: { workspaceID: a.id, workspaceGeneration: a.generation, ...properties } } })) },
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
    import { Show, createSignal } from "solid-js"
    import { ViewActivityProvider } from "@ericsanchezok/synergy-ui/context/view-activity"
    import { FileProvider, useFile, useProjectFiles } from ${JSON.stringify(`/@fs/${appSrc}/context/file/index.tsx`)}
    function Probe(props) { const file = useFile(); const manager = useProjectFiles(); if(props.second) {window.fixture.second = file;window.fixture.secondManager = manager;return <span/>} window.fixture.file = file;window.fixture.manager = manager; return <output>{file.get("same.txt")?.content?.content || "empty"}</output> }
    const [mounted,setMounted] = createSignal(true)
    window.fixture.unmount = () => setMounted(false)
    render(() => <><Show when={mounted()}><ViewActivityProvider active={() => window.fixture.state.visible}><FileProvider><Probe /></FileProvider></ViewActivityProvider></Show><ViewActivityProvider active={() => window.fixture.state.secondVisible}><FileProvider><Probe second /></FileProvider></ViewActivityProvider></>, document.getElementById("root"))
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
            [
              "../sdk",
              "../sync",
              "../workbench",
              "@solidjs/router",
              "@/utils/persist",
              "@/context/locale",
              "@ericsanchezok/synergy-ui/context/dialog",
            ].includes(source)
          )
            return stubs
        },
      },
      solid(),
    ],
    resolve: { alias: { "@/context/session-route": stubs, "@/context/locale": stubs, "@": appSrc } },
    optimizeDeps: { include: ["solid-js", "solid-js/web", "solid-js/store"], noDiscovery: true },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(appSrc, "../../.."), fixture] },
    },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.on("dialog", (dialog) => void dialog.accept())
  page.on("pageerror", (error) => errors.push(error.message))
})
afterEach(async () => {
  await page?.context().close()
})

test("file status invalidations retain one in-flight read and one trailing refresh", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.explorer.loadChildren("")
    for (let i = 0; i < 100; i++) h.emit({ file: `changed-${i}.txt`, event: "changed" })
  })
  expect(await page.evaluate(() => (window as any).fixture.statuses.length)).toBe(1)
  await page.evaluate(() => (window as any).fixture.flushStatuses())
  await page.waitForFunction(() => (window as any).fixture.statuses.length === 2)
  await page.evaluate(() => (window as any).fixture.flushStatuses())
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => (window as any).fixture.statuses.length)).toBe(2)
  expect(errors).toEqual([])
})

test("inactive file consumers defer watcher reads until their activity lease returns", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.visible(false)
    for (let i = 0; i < 100; i++) h.emit({ file: `changed-${i}.txt`, event: "changed" })
  })
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => (window as any).fixture.statuses.length)).toBe(0)
  await page.evaluate(() => (window as any).fixture.visible(true))
  await page.waitForFunction(() => (window as any).fixture.statuses.length === 1)
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.flushStatuses()
    h.select(h.b)
    h.event(h.a)
  })
  await page.waitForTimeout(600)
  expect(
    await page.evaluate(
      () =>
        (window as any).fixture.statuses.filter((item: { workspaceID: string }) => item.workspaceID === "wsp_a").length,
    ),
  ).toBe(1)
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
  ).toEqual(["wsp_a", "wsp_b"])
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.select(h.b)
    void h.file.load("same.txt")
  })
  expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(3)
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

test("watcher refresh cannot bless a dirty editor with a newer disk version", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.file.draft.begin("same.txt")
    h.file.draft.update("same.txt", "local edit")
    h.disk.wsp_a = { content: "external edit", version: "sha256:" + "b".repeat(64) }
    h.event(h.a)
  })
  await page.evaluate(() => (window as any).fixture.flush())
  const result = await page.evaluate(async () => {
    const h = (window as any).fixture
    await h.file.save("same.txt", "local edit").catch(() => {})
    return { write: h.writes[0], draft: h.file.draft.get("same.txt"), disk: h.file.get("same.txt").content.content }
  })
  expect(result.write.workspaceFileWriteFileInput.expectedVersion).toBe("sha256:" + "a".repeat(64))
  expect(result.draft.content).toBe("local edit")
  expect(result.disk).toBe("external edit")
  expect(errors).toEqual([])
}, 30_000)

test("a draft survives Workspace switches and text entered while saving stays dirty", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.file.draft.begin("same.txt")
    h.file.draft.update("same.txt", "first edit")
    h.select(h.b)
  })
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.select(h.a)
  })
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt").content)).toBe("first edit")
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.writeState.mode = "success"
    h.saving = h.file.save("same.txt", "first edit")
    h.file.draft.update("same.txt", "second edit")
    h.writeState.finish()
  })
  await page.waitForFunction(() => (window as any).fixture.requests.length === 2)
  await page.evaluate(() => (window as any).fixture.flush())
  const draft = await page.evaluate(async () => {
    const h = (window as any).fixture
    await h.saving
    return h.file.draft.get("same.txt")
  })
  expect(draft.content).toBe("second edit")
  expect(draft.baseContent).toBe("first edit")
  expect(draft.expectedVersion).toBe("sha256:" + "c".repeat(64))
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.saving = h.file.save("same.txt", "second edit")
    h.writeState.finish()
  })
  await page.waitForFunction(() => (window as any).fixture.requests.length === 3)
  await page.evaluate(() => (window as any).fixture.flush())
  expect(
    await page.evaluate(async () => {
      const h = (window as any).fixture
      await h.saving
      return h.file.draft.get("same.txt")
    }),
  ).toBeUndefined()
  expect(errors).toEqual([])
}, 30_000)

test("watcher bursts coalesce into one subsequent read", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
    for (let i = 0; i < 20; i++) void h.file.load("same.txt", { force: true })
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.waitForFunction(() => (window as any).fixture.requests.length === 2)
  await page.evaluate(() => (window as any).fixture.flush())
  expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(2)
  expect(errors).toEqual([])
}, 30_000)

test("a confirmed filesystem rename cannot retarget or overwrite dirty drafts", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
    void h.file.load("target.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  const result = await page.evaluate(() => {
    const h = (window as any).fixture
    h.file.draft.begin("same.txt")
    h.file.draft.update("same.txt", "source draft")
    h.file.draft.begin("target.txt")
    h.file.draft.update("target.txt", "target draft")
    h.emit({ file: "target.txt", oldPath: "same.txt", event: "renamed" })
    return {
      source: h.file.draft.get("same.txt"),
      target: h.file.draft.get("target.txt"),
      deleted: h.file.get("same.txt").deleted,
    }
  })
  expect(result.source.content).toBe("source draft")
  expect(result.target.content).toBe("target draft")
  expect(result.deleted).toBe(true)
  await page.evaluate(() => (window as any).fixture.flush())
  expect(errors).toEqual([])
}, 30_000)

test("filesystem actions capture Workspace generation and caller-observed entry version", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  const entries = await page.evaluate(async () => {
    const h = (window as any).fixture
    const actions = h.file.entries
    h.select({ ...h.b, generation: 3 })
    await actions.move({ from: "same.txt", to: "renamed.txt", expectedVersion: "entry:observed" })
    await actions.copy({ from: "renamed.txt", to: "copied.txt", expectedVersion: "entry:next" })
    await actions.remove({ path: "copied.txt", expectedVersion: "entry:last", recursive: false })
    return h.entries
  })
  expect(
    entries.map((entry: { workspaceID: string; workspaceGeneration: number }) => [
      entry.workspaceID,
      entry.workspaceGeneration,
    ]),
  ).toEqual([
    ["wsp_a", 1],
    ["wsp_a", 1],
    ["wsp_a", 1],
  ])
  expect(entries[0].workspaceFileMoveInput.expectedVersion).toBe("entry:observed")
  expect(entries[2].workspaceFileDeleteInput.expectedVersion).toBe("entry:last")
  expect(errors).toEqual([])
}, 30_000)

test("a reload restores unsaved text and its original conflict baseline only to the captured Workspace generation", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    void (window as any).fixture.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.evaluate(() => (window as any).fixture.file.draft.update("same.txt", "unsaved after reload"))
  await page.reload()
  await page.waitForSelector("output")
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt"))).toMatchObject({
    content: "unsaved after reload",
    baseContent: "wsp_a",
    expectedVersion: "sha256:" + "a".repeat(64),
  })
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.disk.wsp_a = { content: "new disk", version: "sha256:" + "b".repeat(64) }
    void h.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  const saved = await page.evaluate(async () => {
    const h = (window as any).fixture
    await h.file.save("same.txt", h.file.draft.get("same.txt").content).catch(() => {})
    return h.writes[0]
  })
  expect(saved.workspaceFileWriteFileInput.expectedVersion).toBe("sha256:" + "a".repeat(64))
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.select({ ...h.a, generation: 2 })
  })
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt"))).toBeUndefined()
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.select(h.a)
    h.file.draft.discard("same.txt")
  })
  await page.reload()
  await page.waitForSelector("output")
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt"))).toBeUndefined()
  expect(errors).toEqual([])
}, 30_000)

test("backup quota failure keeps edits in memory, reports the risk and recovers after a successful retry", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    void (window as any).fixture.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError")
    }
    h.file.draft.update("same.txt", "recoverable memory")
  })
  expect(await page.evaluate(() => (window as any).fixture.file.draft.backupUnavailable())).toBe(true)
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt").content)).toBe(
    "recoverable memory",
  )
  await page.evaluate(() => {
    const h = (window as any).fixture
    Storage.prototype.setItem = h.originalSetItem
    h.file.draft.update("same.txt", "durable retry")
  })
  expect(await page.evaluate(() => (window as any).fixture.file.draft.backupUnavailable())).toBe(false)
  await page.reload()
  await page.waitForSelector("output")
  expect(await page.evaluate(() => (window as any).fixture.file.draft.get("same.txt").content)).toBe("durable retry")
  expect(errors).toEqual([])
}, 30_000)

test("a recovered draft remains accessible after the original file disappears", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    void (window as any).fixture.file.load("same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.evaluate(() => (window as any).fixture.file.draft.update("same.txt", "keep despite deletion"))
  await page.reload()
  await page.waitForSelector("output")
  const result = await page.evaluate(async () => {
    const h = (window as any).fixture
    h.disk.wsp_a = { missing: true }
    await h.file.load("same.txt")
    return { draft: h.file.draft.get("same.txt"), deleted: h.file.get("same.txt").deleted }
  })
  expect(result.deleted).toBe(true)
  expect(result.draft.content).toBe("keep despite deletion")
  expect(errors).toEqual([])
}, 30_000)

test("a stored Workspace opens relative files without a controller directory", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => (window as any).fixture.selectObjects())
  await page.evaluate(() => {
    const h = (window as any).fixture
    void h.file.load("same.txt")
    void h.file.load("/same.txt")
    void h.file.load("file:///same.txt")
  })
  await page.evaluate(() => (window as any).fixture.flush())
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "wsp_objects")
  expect(
    await page.evaluate(() => (window as any).fixture.requests.map((q: { workspaceID: string }) => q.workspaceID)),
  ).toEqual(["wsp_objects"])
  expect(errors).toEqual([])
}, 20_000)

test("retained Session providers share a Workspace status request across a visibility switch", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as any).fixture
    h.emit({ file: "changed.txt", event: "changed" })
    h.switchConsumer()
    for (let index = 0; index < 100; index++) h.emit({ file: `changed-${index}.txt`, event: "changed" })
  })
  expect(await page.evaluate(() => (window as any).fixture.statuses.length)).toBe(1)
  await page.evaluate(() => (window as any).fixture.flushStatuses())
  await page.waitForFunction(() => (window as any).fixture.statuses.length === 2)
  await page.evaluate(() => (window as any).fixture.flushStatuses())
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => (window as any).fixture.statuses.length)).toBe(2)
  expect(errors).toEqual([])
})

type ExplorerFixtureWindow = Window & {
  fixture: {
    file: ReturnType<typeof useFile>
    manager: Pick<ReturnType<typeof useProjectFiles>, "clipboard">
    secondManager: Pick<ReturnType<typeof useProjectFiles>, "clipboard">
    entryState: { hold: boolean; signal: AbortSignal; outcome?: string }
    caller: AbortController
    unmount: () => void
    childPages: Record<
      string,
      {
        children: Array<{ path: string; name: string; type: "directory" | "file"; symlink?: boolean }>
        truncated: boolean
        nextCursor?: string
      }
    >
    childRequests: Array<{
      path: string
      cursor?: string
      workspaceID: string
      workspaceGeneration: number
      showHidden: string
      showIgnored: string
    }>
    heldDirectories: string[]
    childFailures: string[]
    requests: unknown[]
    flushDirectories: () => void
    cancelExpansion: () => void
    expansionDone: boolean
    a: { id: string; generation: number; scopeID: string; type: "directory"; path: string }
    b: { id: string; generation: number; scopeID: string; type: "directory"; path: string }
    select: (workspace: ExplorerFixtureWindow["fixture"]["a"]) => void
  }
}

declare const window: ExplorerFixtureWindow

test("source wrapping stays with the file and captured Workspace generation", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  expect(await page.evaluate(() => window.fixture.file.view.wordWrap("same.txt"))).toBe(true)
  await page.evaluate(() => window.fixture.file.view.setWordWrap("same.txt", false))
  expect(await page.evaluate(() => window.fixture.file.view.wordWrap("other.txt"))).toBe(true)
  await page.evaluate(() => window.fixture.select(window.fixture.b))
  expect(await page.evaluate(() => window.fixture.file.view.wordWrap("same.txt"))).toBe(true)
  await page.evaluate(() => window.fixture.select(window.fixture.a))
  expect(await page.evaluate(() => window.fixture.file.view.wordWrap("same.txt"))).toBe(false)
  await page.evaluate(() => window.fixture.select({ ...window.fixture.a, generation: 2 }))
  expect(await page.evaluate(() => window.fixture.file.view.wordWrap("same.txt"))).toBe(true)
  expect(errors).toEqual([])
})

test("file clipboard snapshots retain their source across selection changes and stay local to their provider", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  const snapshot = await page.evaluate(() => {
    const fixture = Reflect.get(window, "fixture")
    const node: FileEntryClipboard["node"] = {
      path: "original.txt",
      name: "original.txt",
      type: "file",
      entryVersion: "entry:observed",
      size: 0,
      mtime: 1,
      ctime: 1,
      ignored: false,
      hidden: false,
      readonly: false,
      symlink: false,
      binary: false,
    }
    const workspace = { ...fixture.a }
    const resourceKey = fixture.file.resourceKey
    fixture.manager.clipboard.set({ resourceKey, workspace, node, operation: "move" })
    node.entryVersion = "entry:changed"
    node.path = "changed.txt"
    workspace.generation = 99
    fixture.select(fixture.b)
    return {
      clipboard: fixture.manager.clipboard.get(),
      sameOwner: fixture.manager.clipboard.get()?.resourceKey === fixture.file.resourceKey,
      otherProvider: fixture.secondManager.clipboard.get(),
    }
  })
  expect(snapshot.clipboard).toMatchObject({
    workspace: { id: "wsp_a", generation: 1 },
    node: { path: "original.txt", entryVersion: "entry:observed" },
    operation: "move",
  })
  expect(snapshot.sameOwner).toBe(false)
  expect(snapshot.otherProvider).toBeUndefined()
  await page.reload()
  await page.waitForSelector("output")
  expect(await page.evaluate(() => Reflect.get(window, "fixture").manager.clipboard.get())).toBeUndefined()
  expect(errors).toEqual([])
})

test("entry writes are cancelled by their FileProvider without aborting the caller's controller", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "fixture")
    fixture.entryState.hold = true
    fixture.caller = new AbortController()
    void fixture.file.entries.createDirectory("created", fixture.caller.signal).catch((error: Error) => {
      fixture.entryState.outcome = error.name
    })
  })
  await page.waitForFunction(() => Reflect.get(window, "fixture").entryState.signal)
  await page.evaluate(() => Reflect.get(window, "fixture").unmount())
  await page.waitForSelector("output", { state: "hidden" })
  expect(await page.evaluate(() => Reflect.get(window, "fixture").entryState.signal.aborted)).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, "fixture").caller.signal.aborted)).toBe(false)
  await page.waitForFunction(() => Reflect.get(window, "fixture").entryState.outcome === "AbortError")
  expect(errors).toEqual([])
})

test("expand all loads every directory page and nested folder without following symbolic links or reading files", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(async () => {
    const h = (window as ExplorerFixtureWindow).fixture
    const directory = (path: string) => ({ path, name: path.split("/").at(-1)!, type: "directory" as const })
    h.childPages[""] = {
      children: [directory("docs"), { ...directory("link"), symlink: true }],
      truncated: true,
      nextCursor: "root-2",
    }
    h.childPages["|root-2"] = { children: [directory("packages")], truncated: false }
    h.childPages.docs = { children: [directory("docs/nested")], truncated: true, nextCursor: "docs-2" }
    h.childPages["docs|docs-2"] = { children: [directory("docs/empty")], truncated: false }
    h.childPages["docs/nested"] = {
      children: [{ path: "docs/nested/deep.txt", name: "deep.txt", type: "file" }],
      truncated: false,
    }
    await h.file.explorer.expandAll()
  })
  const result = await page.evaluate(() => {
    const h = (window as ExplorerFixtureWindow).fixture
    return {
      expanded: h.file.explorer.expanded().toSorted(),
      requests: h.childRequests,
      reads: h.requests.length,
      expanding: h.file.explorer.expandingAll(),
    }
  })
  expect(result.expanded).toEqual(["docs", "docs/empty", "docs/nested", "packages"])
  expect(result.requests.map(({ path, cursor }) => [path, cursor ?? null]).sort()).toEqual(
    [
      ["", null],
      ["", "root-2"],
      ["docs", null],
      ["docs", "docs-2"],
      ["docs/empty", null],
      ["docs/nested", null],
      ["packages", null],
    ].sort(),
  )
  expect(
    result.requests.every(
      (item) =>
        item.workspaceID === "wsp_a" &&
        item.workspaceGeneration === 1 &&
        item.showHidden === "false" &&
        item.showIgnored === "false",
    ),
  ).toBe(true)
  expect(result.reads).toBe(0)
  expect(result.expanding).toBe(false)
  expect(errors).toEqual([])
})

for (const cancel of ["collapse", "abort"] as const) {
  test(`${cancel} stops expansion before late folder replies can reopen descendants`, async () => {
    await page.goto(base)
    await page.waitForSelector("output")
    expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expanded())).toEqual([])
    await page.evaluate((cancel) => {
      const h = (window as ExplorerFixtureWindow).fixture
      h.childPages[""] = { children: [{ path: "docs", name: "docs", type: "directory" }], truncated: false }
      h.childPages.docs = { children: [{ path: "docs/nested", name: "nested", type: "directory" }], truncated: false }
      h.heldDirectories.push("docs")
      const controller = new AbortController()
      h.cancelExpansion = () => (cancel === "collapse" ? h.file.explorer.collapseAll() : controller.abort())
      h.expansionDone = false
      void h.file.explorer.expandAll(controller.signal).then(() => {
        h.expansionDone = true
      })
    }, cancel)
    await page.waitForFunction(() =>
      (window as ExplorerFixtureWindow).fixture.childRequests.some((query) => query.path === "docs"),
    )
    expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expandingAll())).toBe(true)
    await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.cancelExpansion())
    expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expandingAll())).toBe(
      false,
    )
    await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.flushDirectories())
    await page.waitForFunction(() => (window as ExplorerFixtureWindow).fixture.expansionDone)
    expect(
      await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.childRequests.map((query) => query.path)),
    ).toEqual(["", "docs"])
    expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expanded())).toEqual(
      cancel === "collapse" ? [] : ["docs"],
    )
    await page.evaluate(async () => {
      const h = (window as ExplorerFixtureWindow).fixture
      h.heldDirectories.length = 0
      await h.file.explorer.expandAll()
    })
    expect(
      await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expanded().toSorted()),
    ).toEqual(["docs", "docs/nested"])
    expect(errors).toEqual([])
  }, 30_000)
}

test("expand all leaves unreadable-folder errors visible while expanding other branches", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(async () => {
    const h = (window as ExplorerFixtureWindow).fixture
    h.childPages[""] = {
      children: ["blocked", "readable"].map((path) => ({ path, name: path, type: "directory" })),
      truncated: false,
    }
    h.childPages.readable = {
      children: [{ path: "readable/nested", name: "nested", type: "directory" }],
      truncated: false,
    }
    h.childFailures.push("blocked")
    await h.file.explorer.expandAll()
  })
  expect(
    await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expanded().toSorted()),
  ).toEqual(["blocked", "readable", "readable/nested"])
  expect(
    await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.directory("blocked").error),
  ).toBe("Folder is unreadable")
  expect(errors).toEqual([])
})

test("bulk expansion admits only the existing directory concurrency and stops queued branches on collapse", async () => {
  await page.goto(base)
  await page.waitForSelector("output")
  await page.evaluate(() => {
    const h = (window as ExplorerFixtureWindow).fixture
    const folders = Array.from({ length: 30 }, (_, index) => ({
      path: `folder-${index}`,
      name: `folder-${index}`,
      type: "directory" as const,
    }))
    h.childPages[""] = { children: folders, truncated: false }
    h.heldDirectories.push(...folders.map(({ path }) => path))
    h.expansionDone = false
    void h.file.explorer.expandAll().then(() => {
      h.expansionDone = true
    })
  })
  await page.waitForFunction(() => (window as ExplorerFixtureWindow).fixture.childRequests.length >= 7)
  expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.childRequests.length)).toBe(7)
  await page.evaluate(() => {
    const h = (window as ExplorerFixtureWindow).fixture
    h.file.explorer.collapseAll()
    h.flushDirectories()
  })
  await page.waitForFunction(() => (window as ExplorerFixtureWindow).fixture.expansionDone)
  expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.childRequests.length)).toBe(7)
  expect(await page.evaluate(() => (window as ExplorerFixtureWindow).fixture.file.explorer.expanded())).toEqual([])
  expect(errors).toEqual([])
})
