import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
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
        createDirectory: async (query) => { entries.push(query); return { data: { path: "created", node: { path: "created", type: "directory" } } } },
        copy: async (query) => { entries.push(query); return { data: { path: query.workspaceFileCopyInput.to, node: {} } } },
        move: async (query) => { entries.push(query); return { data: { path: query.workspaceFileMoveInput.to, node: {} } } },
        remove: async (query) => { entries.push(query); return { data: { removed: true, path: query.workspaceFileDeleteInput.path } } },
        children: async () => ({ data: { children: [], truncated: false } }) } } },
      event: { listen(cb) { listeners.add(cb); return () => listeners.delete(cb) } } })
    export const useSync = () => ({ data: { path: { directory: "/a", workspace: a } }, session: { get: () => state.session } })
    export const useParams = () => ({ id: "session" })
    export const useWorkbenchPanels = () => ({ surface: () => ({ tabs: () => state.tabs, activeTab: () => state.active }),
      async openPanel(panelId, { init }) { const tab = { id: String(state.tabs.length), panelId, ...init }; setState("tabs", list => [...list, tab]); setState("active", tab); return tab },
      updateTab() {} })
    export const Persist = { workspace: (owner, key) => ({ storage: "fixture:" + owner, key }), scopeKey: (...args) => args.join(":"), scoped: () => ({}) }
    export const persisted = (_key, store) => [...store, undefined, () => true]
    window.fixture = { select(ws) { setState("session", "workspace", ws) }, a, b, requests, writes, entries, disk, state, writeState,
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

beforeEach(async () => {
  if (page.url().startsWith(base)) await page.evaluate(() => localStorage.clear())
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
