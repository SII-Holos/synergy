import type { BrowserDataAction, BrowserDataResult } from "@ericsanchezok/synergy-browser-core"
import type { useSDK } from "@/context/sdk"
import type { BrowserNativeViewBridge } from "@/context/platform"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { useBrowserCatalog } from "./browser-catalog"
import { browserWorkbenchRoute, type BrowserWorkbenchRoute } from "./browser-workbench-model"

export interface BrowserImportTarget {
  action(action: BrowserDataAction): Promise<BrowserDataResult>
  current(): boolean
}

export type BrowserImportTargetResolver = (signal: AbortSignal) => Promise<BrowserImportTarget>

export function createBrowserImportTarget(input: {
  tab: WorkbenchPanelTab
  route: BrowserWorkbenchRoute
  client: ReturnType<typeof useSDK>["client"]
  serverUrl: string
  bridge(): BrowserNativeViewBridge | undefined
  catalog: ReturnType<typeof useBrowserCatalog>
  current(): boolean
  resolveTab?: () => Promise<WorkbenchPanelTab>
  unavailable: string
  closed: string
}): BrowserImportTargetResolver {
  const tab = { ...input.tab }
  return async (signal) => {
    const check = () => {
      signal.throwIfAborted()
      if (!input.current()) throw new Error(input.closed)
    }
    check()
    const resolved = input.resolveTab ? await input.resolveTab() : tab
    check()
    const route = browserWorkbenchRoute(resolved.state) ?? input.route
    if (!resolved.resourceId || (route.serverUrl && route.serverUrl !== input.serverUrl)) throw new Error(input.closed)
    const bridge = input.bridge()
    if (!bridge?.dataAction) throw new Error(input.unavailable)
    const native = bridge.dataAction.bind(bridge)
    const catalog = await input.catalog.get(route)
    check()
    if (route.ownerKey && route.ownerKey !== catalog.route.ownerKey) throw new Error(input.closed)
    let page = catalog.store.session.pages.find((page) => page.id === resolved.resourceId)
    if (!page) {
      await input.catalog.refresh(catalog)
      check()
      page = catalog.store.session.pages.find((page) => page.id === resolved.resourceId)
    }
    if (!page) throw new Error(input.closed)
    if (page.status !== "active") {
      const { openBrowserWorkbenchPage } = await import("./browser-workbench-api")
      await openBrowserWorkbenchPage({
        client: input.client,
        serverUrl: input.serverUrl,
        route: catalog.route,
        bridge,
        pageId: page.id,
      })
      await input.catalog.refresh(catalog)
      check()
      page = catalog.store.session.pages.find((page) => page.id === resolved.resourceId)
      if (!page || page.status !== "active") throw new Error(input.closed)
    }
    const pageId = page.id
    const { BROWSER_PROTOCOL_VERSION } = await import("@ericsanchezok/synergy-browser-core")
    check()
    const current = () =>
      !signal.aborted &&
      input.current() &&
      catalog.store.session.pages.some((page) => page.id === pageId && page.status === "active")
    return {
      current,
      action(action) {
        if (action.type !== "cancelImport") {
          check()
          if (!current()) throw new Error(input.closed)
        }
        return native({ protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey: catalog.route.ownerKey!, pageId, action })
      },
    }
  }
}
