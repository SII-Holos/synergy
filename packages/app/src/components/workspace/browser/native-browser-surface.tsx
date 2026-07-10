import { createEffect, onCleanup, onMount } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"

export function NativeBrowserSurface(props: { container: () => HTMLDivElement | undefined; ownerKey: string }) {
  const browser = useBrowser()
  const platform = usePlatform()

  const bridge = () => {
    if (browser.presentation()?.kind !== "native") return null
    return platform.browserNative ?? null
  }

  function syncBounds() {
    const native = bridge()
    const pageId = browser.pageId()
    const container = props.container()
    if (!native || !pageId || !container) return
    const rect = container.getBoundingClientRect()
    void native.resizeView({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    })
  }

  onMount(() => {
    const unsubscribeNative = platform.browserNative?.onEvent?.((event) => {
      if (event.pageId !== browser.pageId()) return
      switch (event.type) {
        case "native.loading": {
          browser.setPageLoading(event.pageId, true)
          if (event.url) {
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
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId: page.id,
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
    if (pageId)
      void platform.browserNative?.detachView({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: props.ownerKey,
        pageId,
      })
  })

  function focusNativeView() {
    const pageId = browser.pageId()
    if (!pageId) return
    void platform.browserNative?.focusView({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId,
    })
  }

  return <div class="absolute inset-0" onPointerDown={focusNativeView} />
}
