import { createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useSDK } from "@/context/sdk"
import { sameBrowserCatalog, type BrowserWorkbenchRoute } from "./browser-workbench-model"
import type { BrowserAPISessionState } from "@ericsanchezok/synergy-browser-core"
import type { createBrowserStore } from "./browser-store"
import type { createBrowserWebSocket } from "./browser-ws"

export type BrowserCatalog = {
  client: ReturnType<typeof useSDK>["client"]
  route: BrowserWorkbenchRoute
  initial: BrowserAPISessionState
  store: ReturnType<typeof createBrowserStore>
  transport: ReturnType<typeof createBrowserWebSocket>
}

export const { use: useBrowserCatalog, provider: BrowserCatalogProvider } = createSimpleContext({
  name: "BrowserCatalog",
  gate: false,
  init: () => {
    const sdk = useSDK(),
      owner = getOwner()!
    const entries = new Map<string, Promise<BrowserCatalog>>()
    const [loaded, setLoaded] = createSignal<ReadonlyMap<string, BrowserCatalog>>(new Map())
    const keyFor = (route: BrowserWorkbenchRoute) =>
      JSON.stringify([sdk.url, route.mode, route.scopeID, route.sessionID])
    const disposers = new Set<() => void>()
    let disposed = false
    onCleanup(() => {
      disposed = true
      for (const dispose of disposers) dispose()
    })
    return {
      peek(route: BrowserWorkbenchRoute) {
        const value = loaded().get(keyFor(route))
        return value && sameBrowserCatalog(value.route, route) ? value : undefined
      },
      async refresh(catalog: BrowserCatalog) {
        const epoch = catalog.store.session.epoch
        const { BROWSER_PROTOCOL_VERSION } = await import("@ericsanchezok/synergy-browser-core")
        const response = await catalog.client.browser.session(
          { ...catalog.route, presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
          { throwOnError: true },
        )
        const snapshot = response.data
        if (!snapshot || disposed) return
        catalog.transport.applySnapshot(snapshot, epoch)
      },
      get(route: BrowserWorkbenchRoute) {
        const key = keyFor(route)
        const previous = entries.get(key)
        if (previous) return previous
        const client = sdk.client,
          serverUrl = sdk.url
        const result = (async () => {
          const [{ createBrowserStore }, { createBrowserWebSocket }, { BROWSER_PROTOCOL_VERSION }] = await Promise.all([
            import("./browser-store"),
            import("./browser-ws"),
            import("@ericsanchezok/synergy-browser-core"),
          ])
          const response = await client.browser.session(
            { ...route, presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
            { throwOnError: true },
          )
          if (!response.data) throw new Error("Browser state could not be loaded")
          if (disposed) throw new Error("Browser catalog closed during loading")
          const initial = response.data
          const canonical = { ...route, serverUrl, ownerKey: initial.ownerKey }
          return runWithOwner(owner, () =>
            createRoot((dispose) => {
              disposers.add(dispose)
              const store = createBrowserStore()
              store.replacePages(initial.pages)
              store.replaceAgentActivities(initial.agentActivities ?? [])
              store.setSession("seq", initial.seq)
              store.setSession("epoch", initial.epoch)
              store.setPresentation(initial.presentation)
              for (const page of initial.pages)
                store.setHostStatus(page.id, page.status === "active" ? initial.hostStatus : "detached")
              const transport = createBrowserWebSocket(store, {
                mode: route.mode,
                sessionID: route.sessionID,
                scopeID: route.scopeID,
                routeDirectory: route.path_directory,
                ownerKey: initial.ownerKey,
                presentation: "native",
                client,
                serverUrl,
              })
              return { route: canonical, initial, store, transport, client }
            }),
          )!
        })()
          .then((value) => {
            if (!disposed) setLoaded((previous) => new Map(previous).set(key, value))
            return value
          })
          .catch((error) => {
            entries.delete(key)
            throw error
          })
        entries.set(key, result)
        return result
      },
    }
  },
})
