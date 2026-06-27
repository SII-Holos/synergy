import { createEffect, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useBrowser } from "./browser-store"

export function NativeBrowserSurface(props: {
  sessionID: string
  routeDirectory?: string
  container: () => HTMLDivElement | undefined
}) {
  const browser = useBrowser()
  const platform = usePlatform()
  const sdk = useSDK()

  const bridge = () => {
    if (browser.presentation()?.kind !== "native") return null
    return platform.browserNative ?? null
  }

  function syncNativeNavigation(tabId: string, url?: string) {
    if (!url || url === "about:blank") return
    const tab = browser.session.tabs.find((item) => item.id === tabId)
    if (tab?.url === url) return
    browser.send({ type: "navigate", source: "user", tabId, url })
  }

  function syncBounds() {
    const native = bridge()
    const tabId = browser.activeTabId()
    const container = props.container()
    if (!native || !tabId || !container) return
    const rect = container.getBoundingClientRect()
    void native.resizeView({
      tabId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })
  }

  onMount(() => {
    const unsubscribeNative = platform.browserNative?.onEvent?.((event) => {
      if (event.tabId !== browser.activeTabId()) return
      switch (event.type) {
        case "native.loading": {
          browser.setTabLoading(event.tabId, true)
          if (event.url) {
            syncNativeNavigation(event.tabId, event.url)
            browser.setTabUrl(event.tabId, event.url)
          }
          break
        }
        case "native.loaded": {
          browser.setTabLoading(event.tabId, false)
          if (event.url) browser.setTabUrl(event.tabId, event.url)
          if (event.title) browser.setTabTitle(event.tabId, event.title)
          break
        }
        case "native.navigated": {
          syncNativeNavigation(event.tabId, event.url)
          browser.setTabUrl(event.tabId, event.url)
          break
        }
        case "native.title": {
          browser.setTabTitle(event.tabId, event.title)
          break
        }
        case "native.error": {
          browser.setTabLoading(event.tabId, false)
          browser.setBrowserError({ severity: "error", message: event.message, code: String(event.code ?? "") })
          break
        }
      }
    })

    const container = props.container()
    const observer = container ? new ResizeObserver(syncBounds) : null
    if (container) observer?.observe(container)

    onCleanup(() => {
      unsubscribeNative?.()
      observer?.disconnect()
    })
  })

  createEffect(() => {
    const native = bridge()
    const tab = browser.activeTab()
    const container = props.container()
    if (!native || !tab || !container) return

    const rect = container.getBoundingClientRect()
    void native.attachView({
      serverUrl: sdk.url,
      sessionID: props.sessionID,
      routeDirectory: props.routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      tabId: tab.id,
      url: tab.url || undefined,
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    })
  })

  createEffect(() => {
    browser.activeTabId()
    browser.viewportWidth()
    browser.viewportHeight()
    syncBounds()
  })

  onCleanup(() => {
    const tabId = browser.activeTabId()
    if (tabId) void platform.browserNative?.detachView({ tabId })
  })

  function focusNativeView() {
    const tabId = browser.activeTabId()
    if (!tabId) return
    void platform.browserNative?.focusView({ tabId })
  }

  return <div class="absolute inset-0" onPointerDown={focusNativeView} />
}
