import { Show, batch, createEffect, createResource, untrack, on, onCleanup } from "solid-js"
import { useWorkbenchPanels } from "@/context/workbench"
import { useBrowserCatalog, type BrowserCatalog } from "./browser-catalog"
import {
  reconcileBrowserTabs,
  sameBrowserCatalog,
  browserWorkbenchRoute,
  type BrowserWorkbenchRoute,
} from "./browser-workbench-model"

export function BrowserWorkbenchSync(props: { route: BrowserWorkbenchRoute }) {
  const catalog = useBrowserCatalog(),
    workbench = useWorkbenchPanels()
  const [state, { refetch }] = createResource(
    () => props.route,
    async (route) => {
      const knownPageIds = new Set(
        workbench
          .surface("side")
          .tabs()
          .filter((tab) => {
            const owner = browserWorkbenchRoute(tab.state)
            return tab.panelId === "browser" && tab.resourceId && (!owner || sameBrowserCatalog(owner, route))
          })
          .map((tab) => tab.resourceId!),
      )
      return { catalog: await catalog.get(route), knownPageIds }
    },
  )
  createEffect(() => {
    if (!state.error) return
    const retry = setTimeout(() => void refetch(), 5_000)
    onCleanup(() => clearTimeout(retry))
  })
  return (
    <Show when={!state.loading && !state.error ? state() : undefined} keyed>
      {(value) => <SyncState catalog={value.catalog} knownPageIds={value.knownPageIds} />}
    </Show>
  )
}
function SyncState(props: { catalog: BrowserCatalog; knownPageIds: ReadonlySet<string> }) {
  const workbench = useWorkbenchPanels()
  let knownPageIds = props.knownPageIds
  let previousSessionKey = workbench.sessionKey()
  createEffect(
    on(
      () =>
        [
          workbench.sessionKey(),
          props.catalog.store.session.pages.map((page) => ({ id: page.id, title: page.title, url: page.url })),
        ] as const,
      ([sessionKey, pages]) => {
        const surface = workbench.surface("side"),
          tabs = surface.tabs(),
          active = surface.active()
        if (sessionKey !== previousSessionKey) {
          knownPageIds = new Set(
            tabs
              .filter((tab) => {
                const route = browserWorkbenchRoute(tab.state)
                return (
                  tab.panelId === "browser" &&
                  tab.resourceId &&
                  (!route || sameBrowserCatalog(route, props.catalog.route))
                )
              })
              .map((tab) => tab.resourceId!),
          )
          previousSessionKey = sessionKey
        }
        const next = reconcileBrowserTabs({ tabs, active, pages, route: props.catalog.route, knownPageIds })
        knownPageIds = new Set(pages.map((page) => page.id))
        if (next.tabs === tabs && next.active === active) return
        untrack(() =>
          batch(() => {
            surface.setTabs(next.tabs)
            if (active !== undefined || surface.opened()) surface.setActive(next.active)
            if (!next.tabs.length && surface.opened()) surface.close()
          }),
        )
      },
    ),
  )
  return null
}
