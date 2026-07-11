import { createEffect, onCleanup, onMount } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"
import { normalizeBrowserError } from "./browser-error"

export function nativeBounds(rect: Pick<DOMRect, "x" | "y" | "width" | "height">) {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 1 || height < 1) return null
  return { x: Math.round(rect.x), y: Math.round(rect.y), width, height }
}

export function NativeBrowserSurface(props: { container: () => HTMLDivElement | undefined; ownerKey: string }) {
  const browser = useBrowser()
  const platform = usePlatform()
  let attachedPageId: string | null = null
  let disposed = false

  const bridge = () => {
    if (browser.presentation()?.kind !== "native") return null
    return platform.browserNative ?? null
  }

  function syncBounds() {
    const native = bridge()
    const pageId = browser.pageId()
    const container = props.container()
    if (!native || !pageId || !container) return
    const bounds = nativeBounds(container.getBoundingClientRect())
    if (!bounds) return
    void native
      .resizeView({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: props.ownerKey,
        pageId,
        bounds,
      })
      .catch((error) => reportNativeError("resize", pageId, error))
  }

  function reportNativeError(action: "attach" | "resize", pageId: string, error: unknown) {
    if (disposed || browser.pageId() !== pageId) return
    const normalized = normalizeBrowserError(error, `Native Browser ${action} failed`)
    browser.setBrowserError({ severity: "error", message: normalized.message, code: normalized.code })
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

    const bounds = nativeBounds(container.getBoundingClientRect())
    if (!bounds) return
    void native
      .attachView({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: props.ownerKey,
        pageId: page.id,
        bounds,
      })
      .then(
        () => {
          if (!disposed && browser.pageId() === page.id) attachedPageId = page.id
        },
        (error) => reportNativeError("attach", page.id, error),
      )
  })

  createEffect(() => {
    browser.pageId()
    browser.viewportWidth()
    browser.viewportHeight()
    syncBounds()
  })

  onCleanup(() => {
    disposed = true
    const pageId = attachedPageId
    if (pageId)
      void platform.browserNative
        ?.detachView({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: props.ownerKey,
          pageId,
        })
        .catch(() => undefined)
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
