import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"

type BrowserRouteBase = {
  path_directory: string
  query_directory?: string
  scopeID?: string
  ownerKey?: string
  serverUrl?: string
}
export type BrowserWorkbenchRoute = BrowserRouteBase &
  ({ mode: "scope"; scopeID: string; sessionID?: never } | { mode: "session"; sessionID: string })

export function browserWorkbenchRoute(state: unknown): BrowserWorkbenchRoute | undefined {
  if (!state || typeof state !== "object" || !("browserRoute" in state)) return
  const route = state.browserRoute
  if (
    !route ||
    typeof route !== "object" ||
    !("mode" in route) ||
    !("path_directory" in route) ||
    typeof route.path_directory !== "string"
  )
    return
  const base: BrowserRouteBase = { path_directory: route.path_directory }
  const optional = route as Record<string, unknown>
  for (const field of ["query_directory", "scopeID", "ownerKey", "serverUrl"] as const)
    if (typeof optional[field] === "string") base[field] = optional[field]
  if (route.mode === "scope" && base.scopeID && !("sessionID" in route && route.sessionID !== undefined))
    return { ...base, mode: "scope", scopeID: base.scopeID }
  if (route.mode === "session" && "sessionID" in route && typeof route.sessionID === "string")
    return { ...base, mode: "session", sessionID: route.sessionID }
}

export function sameBrowserCatalog(left: BrowserWorkbenchRoute, right: BrowserWorkbenchRoute) {
  if (left.serverUrl && right.serverUrl && left.serverUrl !== right.serverUrl) return false
  if (left.ownerKey && right.ownerKey) return left.ownerKey === right.ownerKey
  return left.mode === right.mode && left.scopeID === right.scopeID && left.sessionID === right.sessionID
}

export function browserPageTab(
  page: { id: string; title: string; url: string },
  route: BrowserWorkbenchRoute,
): WorkbenchPanelTab {
  const identity = route.ownerKey && route.serverUrl ? JSON.stringify([route.serverUrl, route.ownerKey]) : undefined
  return {
    id: identity ? `browser:${identity}:${page.id}` : `browser:${page.id}`,
    panelId: "browser",
    resourceId: page.id,
    title: page.title || page.url,
    state: { browserRoute: route, browserURL: page.url },
    source: identity ?? "browser",
  }
}

export function reconcileBrowserTabs(input: {
  tabs: WorkbenchPanelTab[]
  active: string | undefined
  pages: Array<{ id: string; title: string; url: string }>
  route: BrowserWorkbenchRoute
  knownPageIds?: ReadonlySet<string>
}) {
  const belongs = (tab: WorkbenchPanelTab) => {
    if (tab.panelId !== "browser") return false
    const route = browserWorkbenchRoute(tab.state)
    return !route || sameBrowserCatalog(route, input.route)
  }
  const byId = new Map(input.pages.map((page) => [page.id, page]))
  const represented = new Set(input.tabs.filter(belongs).map((tab) => tab.resourceId))
  const remaining = input.pages.filter((page) => !represented.has(page.id))
  const tabs = input.tabs.flatMap((tab) => {
    if (!belongs(tab)) return [tab]
    const page = tab.resourceId ? byId.get(tab.resourceId) : remaining.shift()
    if (!page) return tab.resourceId && (!input.knownPageIds || input.knownPageIds.has(tab.resourceId)) ? [] : [tab]
    const next = browserPageTab(page, input.route)
    const previous = browserWorkbenchRoute(tab.state)
    if (
      tab.resourceId === next.resourceId &&
      tab.title === next.title &&
      browserTabURL(tab) === page.url &&
      previous?.ownerKey === input.route.ownerKey &&
      previous?.serverUrl === input.route.serverUrl &&
      previous?.mode === input.route.mode &&
      previous?.sessionID === input.route.sessionID &&
      previous?.path_directory === input.route.path_directory &&
      previous?.query_directory === input.route.query_directory &&
      previous?.scopeID === input.route.scopeID &&
      tab.source === next.source
    )
      return [tab]
    return [
      {
        ...tab,
        resourceId: next.resourceId,
        title: next.title,
        source: next.source,
        state: {
          ...(typeof tab.state === "object" && tab.state ? tab.state : {}),
          browserRoute: input.route,
          browserURL: page.url,
        },
      },
    ]
  })
  tabs.push(...remaining.map((page) => browserPageTab(page, input.route)))
  const active = tabs.some((tab) => tab.id === input.active)
    ? input.active
    : (tabs[Math.max(0, input.tabs.findIndex((tab) => tab.id === input.active) - 1)]?.id ?? tabs[0]?.id)
  return {
    tabs:
      tabs.length === input.tabs.length && tabs.every((tab, index) => tab === input.tabs[index]) ? input.tabs : tabs,
    active,
  }
}

export function browserTabURL(tab: WorkbenchPanelTab) {
  const state = tab.state
  return state && typeof state === "object" && "browserURL" in state && typeof state.browserURL === "string"
    ? state.browserURL
    : ""
}
