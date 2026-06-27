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

  function syncNativeNavigation(pageId: string, url?: string) {
    if (!url || url === "about:blank") return
    const page = browser.page()
    if (page?.id !== pageId || page.url === url) return
    browser.send({ type: "navigate", source: "user", pageId, url })
  }

  function syncBounds() {
    const native = bridge()
    const pageId = browser.pageId()
    const container = props.container()
    if (!native || !pageId || !container) return
    const rect = container.getBoundingClientRect()
    void native.resizeView({
      pageId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })
  }

  onMount(() => {
    const unsubscribeNative = platform.browserNative?.onEvent?.((event) => {
      if (event.pageId !== browser.pageId()) return
      switch (event.type) {
        case "native.loading": {
          browser.setPageLoading(event.pageId, true)
          if (event.url) {
            syncNativeNavigation(event.pageId, event.url)
            browser.setPageUrl(event.pageId, event.url)
          }
          break
        }
        case "native.loaded": {
          browser.setPageLoading(event.pageId, false)
          if (event.url) browser.setPageUrl(event.pageId, event.url)
          if (event.title) browser.setPageTitle(event.pageId, event.title)
          break
        }
        case "native.navigated": {
          syncNativeNavigation(event.pageId, event.url)
          browser.setPageUrl(event.pageId, event.url)
          break
        }
        case "native.title": {
          browser.setPageTitle(event.pageId, event.title)
          break
        }
        case "native.error": {
          browser.setPageLoading(event.pageId, false)
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
    const page = browser.page()
    const container = props.container()
    if (!native || !page || !container) return

    const rect = container.getBoundingClientRect()
    void native.attachView({
      serverUrl: sdk.url,
      sessionID: props.sessionID,
      routeDirectory: props.routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      pageId: page.id,
      url: page.url || undefined,
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    })
  })

  createEffect(() => {
    browser.pageId()
    browser.viewportWidth()
    browser.viewportHeight()
    syncBounds()
  })

  onCleanup(() => {
    const pageId = browser.pageId()
    if (pageId) void platform.browserNative?.detachView({ pageId })
  })

  function focusNativeView() {
    const pageId = browser.pageId()
    if (!pageId) return
    void platform.browserNative?.focusView({ pageId })
  }

  return <div class="absolute inset-0" onPointerDown={focusNativeView} />
}
