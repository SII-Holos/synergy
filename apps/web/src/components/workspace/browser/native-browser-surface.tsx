import { claimNativeView } from "./native-view-lease"
import { useViewActivity } from "@/context/view-residency"
import { createEffect, createMemo, createSignal, Show, onCleanup, onMount } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"
import { normalizeBrowserError } from "./browser-error"

export function nativeBrowserViewVisible(input: {
  appDialogOpen: boolean
  fileChooserOpen: boolean
  pageDialogOpen: boolean
  controlsOpen?: boolean
  errorOpen?: boolean
  annotationOpen?: boolean
}) {
  return (
    !input.appDialogOpen &&
    !input.fileChooserOpen &&
    !input.pageDialogOpen &&
    !input.controlsOpen &&
    !input.errorOpen &&
    !input.annotationOpen
  )
}

export function nativeBounds(rect: Pick<DOMRect, "x" | "y" | "width" | "height">) {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 1 || height < 1) return null
  return { x: Math.round(rect.x), y: Math.round(rect.y), width, height }
}

export function NativeBrowserSurface(props: { container: () => HTMLDivElement | undefined; ownerKey: string }) {
  const active = useViewActivity()
  const browser = useBrowser()
  const dialog = useDialog()
  const platform = usePlatform()
  const [cover, setCover] = createSignal<{ pageId: string; url: string; dataUrl: string }>()
  let presentation: ReturnType<typeof claimNativeView> | undefined
  let disposed = false

  const bridge = () => {
    if (browser.presentation()?.kind !== "native") return null
    return platform.browserNative ?? null
  }

  const visible = createMemo(
    () =>
      active() &&
      nativeBrowserViewVisible({
        appDialogOpen: Boolean(dialog.active),
        fileChooserOpen: Boolean(browser.fileChooserRequest()),
        pageDialogOpen: Boolean(browser.dialogRequest()),
        controlsOpen: browser.controlsOpen() || browser.addressSuggestionsOpen(),
        errorOpen: Boolean(browser.browserError()),
        annotationOpen: Boolean(browser.annotationTarget()),
      }),
  )

  function syncBounds() {
    const native = bridge()
    const pageId = browser.pageId()
    const container = props.container()
    if (!active() || !native || !pageId || !container) return
    const bounds = nativeBounds(container.getBoundingClientRect())
    if (!bounds) return
    void presentation
      ?.run(() =>
        native.resizeView({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: props.ownerKey,
          pageId,
          bounds,
        }),
      )
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
        case "native.cover": {
          if (!visible()) setCover(event)
          break
        }
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

    onCleanup(() => unsubscribeNative?.())
  })
  createEffect(() => {
    if (!active()) return
    const container = props.container()
    if (!container) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const native = bridge()
    const page = browser.page()
    const container = props.container()
    if (!active() || !native || !page || !container) return
    const bounds = nativeBounds(container.getBoundingClientRect())
    if (!bounds) return
    const shown = visible()
    const lease = claimNativeView(native, JSON.stringify([props.ownerKey, page.id]))
    presentation = lease
    void lease
      .run(() =>
        native.attachView({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: props.ownerKey,
          pageId: page.id,
          bounds,
          visible: shown,
        }),
      )
      .catch((error) => reportNativeError("attach", page.id, error))
    onCleanup(() => {
      if (presentation === lease) presentation = undefined
      void lease
        .release(() =>
          native.detachView({ protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey: props.ownerKey, pageId: page.id }),
        )
        .catch(() => undefined)
    })
  })

  createEffect(() => {
    browser.pageId()
    if (visible()) setCover(undefined)
    browser.viewportWidth()
    browser.viewportHeight()
    syncBounds()
  })

  onCleanup(() => {
    disposed = true
  })

  function focusNativeView() {
    const pageId = browser.pageId()
    if (!pageId || !visible()) return
    void platform.browserNative?.focusView({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId,
    })
  }

  return (
    <div class="absolute inset-0" onPointerDown={focusNativeView}>
      <Show when={!visible() && cover()?.pageId === browser.pageId() && cover()?.url === browser.page()?.url}>
        <img src={cover()?.dataUrl} alt="" aria-hidden="true" class="pointer-events-none h-full w-full object-fill" />
      </Show>
    </div>
  )
}
