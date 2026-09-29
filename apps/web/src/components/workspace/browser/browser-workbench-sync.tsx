import { Show, batch, createEffect, createResource, untrack, on, onCleanup } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { BROWSER_PROTOCOL_VERSION, type BrowserAPISessionState } from "@ericsanchezok/synergy-browser-core"
import { createBrowserStore } from "./browser-store"
import { createBrowserWebSocket } from "./browser-ws"
import { reconcileBrowserTabs, type BrowserWorkbenchRoute } from "./browser-workbench-model"

export function BrowserWorkbenchSync(props: { route: BrowserWorkbenchRoute }) {
  const sdk = useSDK()
  const workbench = useWorkbenchPanels()
  const [state, { refetch }] = createResource(
    () => props.route,
    async (route) => {
      const knownPageIds = new Set(
        workbench
          .surface("side")
          .tabs()
          .filter((tab) => tab.panelId === "browser" && tab.resourceId)
          .map((tab) => tab.resourceId!),
      )
      const response = await sdk.client.browser.session(
        { ...route, mode: "session", presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
        { throwOnError: true },
      )
      if (!response.data) throw new Error("Browser state could not be loaded")
      return { state: response.data, route, knownPageIds }
    },
  )
  createEffect(() => {
    if (!state.error) return
    const retry = setTimeout(() => void refetch(), 5_000)
    onCleanup(() => clearTimeout(retry))
  })
  return (
    <Show when={!state.loading && !state.error ? state() : undefined} keyed>
      {(value) => <SyncState initial={value.state} route={value.route} knownPageIds={value.knownPageIds} />}
    </Show>
  )
}
function SyncState(props: {
  initial: BrowserAPISessionState
  route: BrowserWorkbenchRoute
  knownPageIds: ReadonlySet<string>
}) {
  const workbench = useWorkbenchPanels()
  const store = createBrowserStore()
  store.replacePages(props.initial.pages)
  store.setSession("seq", props.initial.seq)
  store.setSession("epoch", props.initial.epoch)
  createBrowserWebSocket(store, {
    sessionID: props.route.sessionID,
    ownerKey: props.initial.ownerKey,
    routeDirectory: props.route.path_directory,
    presentation: "native",
  })
  let knownPageIds = props.knownPageIds
  createEffect(
    on(
      () => store.session.pages.map((page) => ({ id: page.id, title: page.title, url: page.url })),
      (pages) => {
        const surface = workbench.surface("side")
        const tabs = surface.tabs(),
          active = surface.active()
        const next = reconcileBrowserTabs({ tabs, active, pages, route: props.route, knownPageIds })
        knownPageIds = new Set(pages.map((page) => page.id))
        if (next.tabs === tabs && next.active === active) return
        untrack(() =>
          batch(() => {
            surface.setTabs(next.tabs)
            surface.setActive(next.active)
          }),
        )
      },
    ),
  )
  return null
}
