import { afterEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type { BrowserNativeViewBridge } from "../../../../src/context/platform"
import type { BrowserCatalog } from "../../../../src/components/workspace/browser/browser-catalog"
import type { WorkbenchPanelTab } from "../../../../src/plugin/registries/workbench-panel-registry"
import { createBrowserStore, type BrowserPage } from "../../../../src/components/workspace/browser/browser-store"
import { createBrowserImportTarget } from "../../../../src/components/workspace/browser/browser-import-target"

const disposers: VoidFunction[] = []
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))
const page = (id: string): BrowserPage => ({
  id,
  profileId: "personal",
  title: id,
  url: "about:blank",
  status: "active",
  isLoading: false,
  lastActiveAt: null,
})

function fixture() {
  return createRoot((dispose) => {
    disposers.push(dispose)
    const store = createBrowserStore()
    store.replacePages([page("original"), page("other")])
    const requests: Request[] = []
    const native: Parameters<NonNullable<BrowserNativeViewBridge["dataAction"]>>[0][] = []
    const client = createSynergyClient({
      baseUrl: "http://browser.test",
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const request = new Request(input)
          requests.push(request.clone())
          return request.method === "GET"
            ? Response.json({ ownerKey: "canonical-owner", pages: [{ ...page("original"), status: "suspended" }] })
            : Response.json({
                type: "control.result",
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                result: { type: "page", page: page("original") },
              })
        },
        { preconnect() {} },
      ),
    })
    const unused = async () => {
      throw new Error("Presentation is outside import discovery")
    }
    let bridge: BrowserNativeViewBridge | undefined = {
      attachView: unused,
      detachView: unused,
      focusView: unused,
      resizeView: unused,
      retryPage: unused,
      presentationCapability: unused,
      createPresentationTicket: async () => ({
        ok: true,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ticket: "fixture-ticket",
      }),
      dataAction: async (input) => {
        native.push(input)
        return { type: "done" }
      },
    }
    const route = {
      mode: "scope" as const,
      scopeID: "scope-one",
      path_directory: "home",
      ownerKey: "canonical-owner",
      serverUrl: "http://browser.test",
    }
    const entry: BrowserCatalog = {
      route,
      client,
      store,
      initial: {
        type: "session.state",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        status: "active",
        ownerKey: route.ownerKey,
        pages: [],
        presentation: null,
        hostStatus: "ready",
        seq: 1,
        epoch: "one",
      },
      transport: {
        send() {},
        createNativeTicket: async () => "fixture-ticket",
        connect: async () => {},
        reconnect() {},
        retryNative() {},
      },
    }
    const catalog = { get: async () => entry, refresh: async (_entry: BrowserCatalog) => {} }
    const tab: WorkbenchPanelTab = { id: "tab-one", panelId: "browser", resourceId: "original" }
    let current = true
    const input = {
      tab,
      route,
      client,
      serverUrl: route.serverUrl,
      bridge: () => bridge,
      catalog,
      current: () => current,
      unavailable: "Native import unavailable",
      closed: "Original target closed",
    }
    return {
      input,
      native,
      requests,
      store,
      entry,
      setBridge(value: BrowserNativeViewBridge | undefined) {
        bridge = value
      },
      invalidate() {
        current = false
      },
    }
  })
}

test("import retains its initiating tab, canonical owner and native bridge after selection changes", async () => {
  const value = fixture()
  const resolve = createBrowserImportTarget(value.input)
  value.input.tab.resourceId = "other"
  const target = await resolve(new AbortController().signal)
  value.store.selectPage("other")
  value.setBridge(undefined)
  await target.action({ type: "importSources" })
  expect(value.native).toEqual([
    {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "canonical-owner",
      pageId: "original",
      action: { type: "importSources" },
    },
  ])
  expect(target.current()).toBe(true)
  expect(value.requests).toEqual([])
})

test("pending discovery shares its opening and aborts without native work after dialog dismissal", async () => {
  const value = fixture()
  let finish!: (tab: WorkbenchPanelTab) => void
  const pending = new Promise<WorkbenchPanelTab>((resolve) => {
    finish = resolve
  })
  const controller = new AbortController()
  const target = createBrowserImportTarget({ ...value.input, resolveTab: () => pending })(controller.signal)
  expect(value.native).toEqual([])
  controller.abort()
  finish(value.input.tab)
  await expect(target).rejects.toThrow()
  expect(value.native).toEqual([])
  expect(value.requests).toEqual([])
})

test("missing native data capability stays actionable and can be retried for the same page", async () => {
  const value = fixture()
  const original = value.input.bridge()!
  value.setBridge(undefined)
  const resolve = createBrowserImportTarget(value.input)
  await expect(resolve(new AbortController().signal)).rejects.toThrow("Native import unavailable")
  value.setBridge({ ...original, dataAction: undefined })
  await expect(resolve(new AbortController().signal)).rejects.toThrow("Native import unavailable")
  value.setBridge(original)
  const target = await resolve(new AbortController().signal)
  await target.action({ type: "state" })
  expect(value.native[0]?.pageId).toBe("original")
})

test("a missing known page refreshes metadata but never creates a replacement", async () => {
  const value = fixture()
  value.store.replacePages([page("other")])
  let reads = 0
  value.input.catalog.refresh = async () => {
    reads++
  }
  await expect(createBrowserImportTarget(value.input)(new AbortController().signal)).rejects.toThrow(
    "Original target closed",
  )
  expect(reads).toBe(1)
  expect(value.native).toEqual([])
  expect(value.requests).toEqual([])
})

test("suspended import pages explicitly resume their own identity before discovery", async () => {
  const value = fixture()
  value.store.upsertPage({ ...page("original"), status: "suspended" })
  value.input.catalog.refresh = async () => {
    value.store.upsertPage(page("original"))
  }
  const target = await createBrowserImportTarget(value.input)(new AbortController().signal)
  const writes = value.requests.filter((request) => request.method === "POST")
  expect(writes).toHaveLength(1)
  expect(await writes[0]!.json()).toMatchObject({ pageId: "original", command: { type: "resume" } })
  await target.action({ type: "importSources" })
  expect(value.native[0]?.pageId).toBe("original")
})

test("closed or invalidated targets refuse new work while cancellation retains the original destination", async () => {
  const value = fixture()
  const controller = new AbortController()
  const target = await createBrowserImportTarget(value.input)(controller.signal)
  value.store.removePage("original")
  expect(target.current()).toBe(false)
  await expect(Promise.resolve().then(() => target.action({ type: "state" }))).rejects.toThrow("Original target closed")
  value.invalidate()
  controller.abort()
  await target.action({ type: "cancelImport", requestId: "job-one" })
  expect(value.native).toEqual([
    {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "canonical-owner",
      pageId: "original",
      action: { type: "cancelImport", requestId: "job-one" },
    },
  ])
})

test("a changed server, absent resource or context change during resolution cannot dispatch metadata", async () => {
  const value = fixture()
  const controller = new AbortController()
  await expect(
    createBrowserImportTarget({
      ...value.input,
      tab: { ...value.input.tab, state: { browserRoute: { ...value.input.route, serverUrl: "http://other.test" } } },
    })(controller.signal),
  ).rejects.toThrow("Original target closed")
  await expect(
    createBrowserImportTarget({ ...value.input, tab: { id: "pending", panelId: "browser" } })(controller.signal),
  ).rejects.toThrow("Original target closed")
  let finish!: (tab: WorkbenchPanelTab) => void
  const pending = new Promise<WorkbenchPanelTab>((resolve) => {
    finish = resolve
  })
  const target = createBrowserImportTarget({ ...value.input, resolveTab: () => pending })(controller.signal)
  value.invalidate()
  finish(value.input.tab)
  await expect(target).rejects.toThrow("Original target closed")
  expect(value.native).toEqual([])
})

test("a different canonical owner cannot receive a saved import target", async () => {
  const value = fixture()
  const tab = { ...value.input.tab, state: { browserRoute: { ...value.input.route, ownerKey: "previous-owner" } } }
  await expect(createBrowserImportTarget({ ...value.input, tab })(new AbortController().signal)).rejects.toThrow(
    "Original target closed",
  )
  expect(value.native).toEqual([])
})

test("failed recovery retains the target and reports metadata or inactive-page errors", async () => {
  const value = fixture()
  value.store.replacePages([])
  value.input.catalog.refresh = async () => {
    throw new Error("Metadata offline")
  }
  const resolve = createBrowserImportTarget(value.input)
  await expect(resolve(new AbortController().signal)).rejects.toThrow("Metadata offline")
  value.store.upsertPage({ ...page("original"), status: "suspended" })
  value.input.catalog.refresh = async () => {}
  await expect(resolve(new AbortController().signal)).rejects.toThrow("Original target closed")
  expect(value.native).toEqual([])
})
