import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"

export interface BrowserWorkbenchRoute {
  sessionID: string
  path_directory: string
  query_directory?: string
  scopeID?: string
}
export function browserWorkbenchRoute(state: unknown): BrowserWorkbenchRoute | undefined {
  if (!state || typeof state !== "object" || !("browserRoute" in state)) return
  const route = state.browserRoute
  if (!route || typeof route !== "object" || !("sessionID" in route) || !("path_directory" in route)) return
  if (typeof route.sessionID !== "string" || typeof route.path_directory !== "string") return
  return {
    sessionID: route.sessionID,
    path_directory: route.path_directory,
    ...("query_directory" in route && typeof route.query_directory === "string"
      ? { query_directory: route.query_directory }
      : {}),
    ...("scopeID" in route && typeof route.scopeID === "string" ? { scopeID: route.scopeID } : {}),
  }
}
export function browserPageTab(
  page: { id: string; title: string; url: string },
  route: BrowserWorkbenchRoute,
): WorkbenchPanelTab {
  return {
    id: `browser:${page.id}`,
    panelId: "browser",
    resourceId: page.id,
    title: page.title || page.url,
    state: { browserRoute: route, browserURL: page.url },
    source: "browser",
  }
}
export function reconcileBrowserTabs(input: {
  tabs: WorkbenchPanelTab[]
  active: string | undefined
  pages: Array<{ id: string; title: string; url: string }>
  route: BrowserWorkbenchRoute
  knownPageIds?: ReadonlySet<string>
}) {
  const byId = new Map(input.pages.map((page) => [page.id, page]))
  const represented = new Set(input.tabs.filter((tab) => tab.panelId === "browser").map((tab) => tab.resourceId))
  const remaining = input.pages.filter((page) => !represented.has(page.id))
  const tabs = input.tabs.flatMap((tab) => {
    if (tab.panelId !== "browser") return [tab]
    const page = tab.resourceId ? byId.get(tab.resourceId) : remaining.shift()
    if (!page) return tab.resourceId && (!input.knownPageIds || input.knownPageIds.has(tab.resourceId)) ? [] : [tab]
    const next = browserPageTab(page, input.route)
    const route = browserWorkbenchRoute(tab.state)
    if (
      tab.resourceId === next.resourceId &&
      tab.title === next.title &&
      browserTabURL(tab) === page.url &&
      route?.sessionID === input.route.sessionID &&
      route.path_directory === input.route.path_directory &&
      route.query_directory === input.route.query_directory &&
      route.scopeID === input.route.scopeID
    )
      return [tab]
    return [
      {
        ...tab,
        resourceId: next.resourceId,
        title: next.title,
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
