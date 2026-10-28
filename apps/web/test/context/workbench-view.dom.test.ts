import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import type { ServerWebSocket } from "bun"

const source = path.resolve(import.meta.dir, "../../src")
const fixture = path.resolve(import.meta.dir, "../fixtures/workbench-view")
const resolveUI = createRequire(path.resolve(source, "../../../packages/ui/package.json"))
const frames: WorkbenchView.ClientMessage[] = []
const sockets: ServerWebSocket<unknown>[] = []
const errors: string[] = []
let backend: ReturnType<typeof Bun.serve>, server: ViteDevServer, browser: Browser, page: Page, cache: string
const context = {
  state: "bound" as const,
  workspace: { id: "wsp_fixture", generation: 2, root: "/fixture" },
  directory: "",
}
let sequence = 0
async function waitUntil(predicate: () => boolean) {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Workbench receipt did not arrive")
    await Bun.sleep(10)
  }
}
async function request(
  command: WorkbenchView.Command,
  options: { requestId?: string; sessionID?: string; context?: WorkbenchView.Request["context"] } = {},
) {
  const requestId = options.requestId ?? `request-${++sequence}`
  sockets.at(-1)!.send(
    JSON.stringify({
      payload: {
        type: "server.workbench.request",
        properties: {
          requestId,
          scopeID: "scope",
          sessionID: options.sessionID ?? "session-a",
          command,
          ...(options.context ? { context: options.context } : {}),
        },
      },
    }),
  )
  return requestId
}
async function receipt(requestId: string) {
  await waitUntil(() =>
    frames.some((frame) => frame.type === "client.workbench.receipt" && frame.properties.requestId === requestId),
  )
  return (
    frames.findLast(
      (frame) => frame.type === "client.workbench.receipt" && frame.properties.requestId === requestId,
    ) as Extract<WorkbenchView.ClientMessage, { type: "client.workbench.receipt" }>
  ).properties.outcome
}
async function open(target: WorkbenchView.Target) {
  return receipt(await request({ action: "open", target }, { context }))
}
async function reset() {
  frames.length = 0
  errors.length = 0
  await page.goto(`${server.resolvedUrls!.local[0]}?backend=${encodeURIComponent(`http://127.0.0.1:${backend.port}`)}`)
  expect(errors).toEqual([])
  expect(await page.locator("#root").evaluate((root) => root.childElementCount)).toBeGreaterThan(0)
  await page.waitForSelector('textarea[aria-label="Composer"]')
}
async function act(method: string, ...args: unknown[]) {
  return page.evaluate(
    ({ method, args }) => Reflect.apply(Reflect.get(Reflect.get(window, "fixture"), method), undefined, args),
    { method, args },
  )
}

beforeAll(async () => {
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: await fixturePort(),
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) {
        sockets.push(socket)
      },
      message(_socket, data) {
        const result = WorkbenchView.ClientMessage.safeParse(JSON.parse(String(data)).payload)
        if (result.success) frames.push(result.data)
      },
    },
  })
  cache = await mkdtemp(path.join(import.meta.dir, ".workbench-view-"))
  const bridge = path.join(fixture, "services.ts")
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: cache,
    plugins: [solid()],
    resolve: {
      alias: [
        { find: "lucide-solid", replacement: resolveUI.resolve("lucide-solid") },
        {
          find: "@ericsanchezok/synergy-sdk/client",
          replacement: path.resolve(source, "../../../packages/sdk/js/src/client.ts"),
        },
        {
          find: /^@ericsanchezok\/synergy-plugin\/(.+)$/,
          replacement: path.resolve(source, "../../../packages/plugin/src/$1.ts"),
        },
        {
          find: /^@ericsanchezok\/synergy-plugin$/,
          replacement: path.resolve(source, "../../../packages/plugin/src/index.ts"),
        },
        ...[
          "./platform",
          "./server",
          "../sdk",
          "../sync",
          "../layout",
          "@/context/platform",
          "@/context/sdk",
          "@/context/sync",
          "@/context/layout",
          "@/context/session-route",
          "@/context/locale",
          "@/context/session-transition",
          "@/plugin/host",
          "@/components/note/documents",
          "@/components/workspace/browser/browser-catalog",
          "@/components/dialog/confirm-dialog",
          "@/components/performance/browser-metrics",
        ].map((find) => ({
          find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          replacement: bridge,
        })),
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "@lingui/core",
        "@lingui/solid",
        "zod",
        "fuzzysort",
        "lucide-solid",
      ],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      hmr: false,
      fs: { allow: [path.resolve(source, "../../.."), cache] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on("pageerror", (error) => errors.push(error.message))
  await reset()
}, 60000)
afterEach(() => expect(errors).toEqual([]))
afterAll(async () => {
  await browser?.close()
  await server?.close()
  backend?.stop(true)
  if (cache) await rm(cache, { recursive: true, force: true })
})

test("connected resource executor advertises only live ownership and selects canonical views without stealing focus", async () => {
  await reset()
  await waitUntil(() =>
    frames.some((frame) => frame.type === "client.workbench.ready" && frame.properties.targets.length === 4),
  )
  const composer = page.getByRole("textbox", { name: "Composer", exact: true })
  await composer.fill("draft kept")
  await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 6, "backward"))
  await act("hold")
  const noteRequest = await request({ action: "open", target: { kind: "note", id: "note" } })
  await page.waitForFunction(() => Reflect.get(window, "fixture").reads.includes("/note/meta"))
  await composer.press("ArrowLeft")
  const selection = await composer.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
    element.selectionDirection,
  ])
  await act("resolve")
  const note = await receipt(noteRequest)
  expect(note.status).toBe("applied")
  expect(note.views).toContainEqual(
    expect.objectContaining({
      target: { kind: "note", id: "note" },
      surface: "side",
      visible: true,
      contentState: "loading",
    }),
  )
  expect(
    await composer.evaluate((element: HTMLTextAreaElement) => [
      document.activeElement === element,
      element.value,
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual([true, "draft kept", ...selection])
  expect(await page.locator('[data-testid="document"][data-resource="note"]').isVisible()).toBe(true)
  const first = note.views!.find((view) => view.visible)!
  expect((await open({ kind: "note", id: "note" })).views!.find((view) => view.visible)?.viewId).toBe(first.viewId)
  const file = await open({ kind: "workspace-file", path: "one.ts", location: { kind: "text", line: 1 } })
  expect(file).toMatchObject({ status: "applied" })
  expect(await page.locator('[data-resource="wsp_fixture@2/one.ts"]').isVisible()).toBe(true)
  expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true)
  expect((await open({ kind: "browser-page", pageId: "page" })).status).toBe("applied")
  expect(await page.locator('[data-resource="page"]').isVisible()).toBe(true)
  expect((await open({ kind: "asset", url: "asset://0123456789abcdef.txt" })).status).toBe("applied")
  expect(await page.locator('[data-resource="asset://0123456789abcdef.txt"]').isVisible()).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, "fixture").effects)).toEqual([])
  const status = await receipt(await request({ action: "status" }))
  expect(status.views).toHaveLength(4)
  expect((await receipt(await request({ action: "hide", viewId: first.viewId }))).status).toBe("superseded")
  expect(await page.locator('[data-resource="asset://0123456789abcdef.txt"]').isVisible()).toBe(true)
  const current = status.views!.find((view) => view.visible)!
  expect((await receipt(await request({ action: "hide", viewId: current.viewId }))).status).toBe("applied")
  expect(await page.locator('[data-resource="asset://0123456789abcdef.txt"]').isVisible()).toBe(false)
  expect(((await act("tabs")) as unknown[]).length).toBe(4)
  expect(await act("reveal")).toEqual({})
}, 30000)

test("a returned file view cannot hide a replacement Workspace resource with the same relative path", async () => {
  await reset()
  await waitUntil(() =>
    frames.some((frame) => frame.type === "client.workbench.ready" && frame.properties.targets.length),
  )
  const file = await open({ kind: "workspace-file", path: "one.ts" })
  const view = file.views!.find((view) => view.visible)!
  await act("replaceFileWorkspace", view.viewId)
  expect((await receipt(await request({ action: "hide", viewId: view.viewId }))).status).toBe("superseded")
  expect(await page.locator('[data-resource="wsp_replacement@3/one.ts"]').isVisible()).toBe(true)
})

test("user tab/session changes, cancel and disconnect fence delayed requests; duplicates and history cannot replay effects", async () => {
  await reset()
  await waitUntil(() =>
    frames.some((frame) => frame.type === "client.workbench.ready" && frame.properties.targets.length),
  )
  const asset = await open({ kind: "asset", url: "asset://0123456789abcdef.txt" })
  const assetID = asset.views!.find((view) => view.visible)!.viewId
  await act("captureReply")
  sockets.at(-1)!.send(JSON.stringify({ payload: { type: "server.workbench.probe" } }))
  await page.waitForFunction(() => Reflect.get(window, "fixture").hasReply())
  for (const action of ["tab", "session", "cancel", "disconnect"] as const) {
    await act("hold")
    const prior = await page.evaluate(() => Reflect.get(window, "fixture").reads.length)
    const id = await request({ action: "open", target: { kind: "note", id: "note" } })
    await page.waitForFunction((count) => Reflect.get(window, "fixture").reads.length > count, prior)
    if (action === "tab") await act("select", assetID)
    if (action === "session") {
      await act("setSession", "session-b")
      await act("setSession", "session-a")
    }
    if (action === "cancel")
      sockets
        .at(-1)!
        .send(JSON.stringify({ payload: { type: "server.workbench.cancel", properties: { requestId: id } } }))
    if (action === "disconnect") {
      const count = sockets.length
      sockets.at(-1)!.close()
      await waitUntil(() => sockets.length > count)
      await page.waitForFunction(() => Reflect.get(window, "fixture").sdk().connected())
      expect(await act("replyOld")).toBe(false)
      expect(
        frames.filter(
          (frame) => frame.type === "client.workbench.receipt" && frame.properties.requestId === "old-socket",
        ),
      ).toEqual([])
    }
    await act("resolve")
    if (action !== "disconnect") expect(["superseded", "cancelled"]).toContain((await receipt(id)).status)
    else
      expect(
        frames.filter((frame) => frame.type === "client.workbench.receipt" && frame.properties.requestId === id),
      ).toEqual([])
    expect(await page.locator('[data-resource="asset://0123456789abcdef.txt"]').isVisible()).toBe(true)
  }
  await act("hold")
  const id = await request({ action: "open", target: { kind: "note", id: "note" } })
  await request({ action: "open", target: { kind: "note", id: "note" } }, { requestId: id })
  await act("resolve")
  expect((await receipt(id)).status).toBe("applied")
  const count = ((await act("tabs")) as unknown[]).length
  await request({ action: "open", target: { kind: "asset", url: "asset://0123456789abcdef.pdf" } }, { requestId: id })
  await waitUntil(() =>
    frames.some(
      (frame) =>
        frame.type === "client.workbench.receipt" &&
        frame.properties.requestId === id &&
        frame.properties.outcome.status === "blocked",
    ),
  )
  sockets.at(-1)!.send(
    JSON.stringify({
      scopeID: "scope",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "browser_view",
            state: { status: "completed", metadata: { action: "focus", pageId: "old-page" } },
          },
        },
      },
    }),
  )
  await Bun.sleep(50)
  expect(((await act("tabs")) as unknown[]).length).toBe(count)
  expect(await page.evaluate(() => Reflect.get(window, "fixture").events)).not.toContain("server.workbench.request")
  await act("setActive", false)
  await waitUntil(
    () =>
      frames.at(-1)?.type === "client.workbench.ready" &&
      !(frames.at(-1) as Extract<WorkbenchView.ClientMessage, { type: "client.workbench.ready" }>).properties.targets
        .length,
  )
  await act("setActive", true)
  const pendingReads = await page.evaluate(() => Reflect.get(window, "fixture").reads.length)
  await act("hold")
  const disposing = await request({ action: "open", target: { kind: "note", id: "other-note" } })
  await page.waitForFunction((count) => Reflect.get(window, "fixture").reads.length > count, pendingReads)
  await act("setMounted", false)
  await waitUntil(
    () => frames.findLast((frame) => frame.type === "client.workbench.ready")?.properties.targets.length === 0,
  )
  await act("resolve")
  expect(["superseded", "cancelled"]).toContain((await receipt(disposing)).status)
}, 30000)

test("unavailable targets, absent context and modal/dirty protection never report success or replace drafts", async () => {
  await reset()
  await waitUntil(() =>
    frames.some((frame) => frame.type === "client.workbench.ready" && frame.properties.targets.length),
  )
  expect(
    (await receipt(await request({ action: "open", target: { kind: "workspace-file", path: "one.ts" } }))).status,
  ).toBe("unavailable")
  expect(
    (
      await receipt(
        await request(
          { action: "open", target: { kind: "workspace-file", path: "one.ts" } },
          { context: { ...context, workspace: { ...context.workspace, generation: 1 } } },
        ),
      )
    ).status,
  ).toBe("unavailable")
  expect((await open({ kind: "browser-page", pageId: "missing" })).status).toBe("unavailable")
  await act("pages", "suspended")
  expect((await open({ kind: "browser-page", pageId: "page" })).status).toBe("unavailable")
  await act("setNative", false)
  expect((await open({ kind: "browser-page", pageId: "page" })).status).toBe("unavailable")
  await act("showDialog")
  expect((await open({ kind: "note", id: "note" })).status).toBe("blocked")
  await act("closeDialog")
  await page.setViewportSize({ width: 600, height: 900 })
  expect((await open({ kind: "note", id: "note" })).status).toBe("blocked")
  await page.setViewportSize({ width: 1400, height: 900 })
  expect((await open({ kind: "workspace-file", path: "one.ts" })).status).toBe("applied")
  const draft = page.getByRole("textbox", { name: "File draft" })
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="File draft"]')?.value === "Saved file body",
  )
  await draft.fill("Unsaved file draft")
  expect(await act("draft")).toMatchObject({ content: "Unsaved file draft" })
  expect((await open({ kind: "note", id: "note" })).status).toBe("blocked")
  await page.getByRole("textbox", { name: "Composer", exact: true }).focus()
  expect(await open({ kind: "workspace-file", path: "two.ts" })).toMatchObject({ status: "applied" })
  const status = await receipt(await request({ action: "status" }))
  const first = status.views!.find((view) => view.target.kind === "workspace-file" && view.target.path === "one.ts")!
  await act("select", first.viewId)
  expect(await draft.inputValue()).toBe("Unsaved file draft")
  expect(await act("draft")).toMatchObject({ content: "Unsaved file draft" })
  expect(await page.evaluate(() => Reflect.get(window, "fixture").effects)).toEqual([])
}, 30000)
