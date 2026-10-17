import { claimNativeView } from "./native-view-lease"
import { useViewActivity } from "@/context/view-residency"
import { createEffect, createMemo, createSignal, Show, onCleanup, onMount, useContext } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"
import { normalizeBrowserError } from "./browser-error"
import { WorkbenchSurfaceOverlay } from "../workbench-surface-overlay"

export function nativeBrowserViewVisible(input: {
  appDialogOpen: boolean
  fileChooserOpen: boolean
  pageDialogOpen: boolean
  controlsOpen?: boolean
  annotationOpen?: boolean
  workspaceMenuOpen?: boolean
}) {
  return (
    !input.appDialogOpen &&
    !input.fileChooserOpen &&
    !input.pageDialogOpen &&
    !input.controlsOpen &&
    !input.annotationOpen &&
    !input.workspaceMenuOpen
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
  const workspaceMenuOpen = useContext(WorkbenchSurfaceOverlay)
  const [cover, setCover] = createSignal<{ pageId: string; url: string; dataUrl: string }>()
  const [bounds, setBounds] = createSignal<ReturnType<typeof nativeBounds>>(null, {
    equals: (left, right) =>
      left?.x === right?.x && left?.y === right?.y && left?.width === right?.width && left?.height === right?.height,
  })
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
        annotationOpen: Boolean(browser.annotationTarget()),
        workspaceMenuOpen: workspaceMenuOpen(),
      }),
  )

  function syncBounds() {
    const container = props.container()
    setBounds(active() && container ? nativeBounds(container.getBoundingClientRect()) : null)
  }

  function reportNativeError(action: "attach" | "resize", pageId: string, error: unknown) {
    if (disposed || browser.pageId() !== pageId) return
    const normalized = normalizeBrowserError(error, `Native Browser ${action} failed`)
    browser.setBrowserError({ pageId, severity: "error", message: normalized.message, code: normalized.code })
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
          if (event.url) browser.setPageUrl(event.pageId, event.url)
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
          browser.setBrowserError({
            pageId: event.pageId,
            severity: "error",
            message: event.message,
            code: String(event.code ?? ""),
          })
          break
        }
      }
    })
    onCleanup(() => unsubscribeNative?.())
  })

  createEffect(() => {
    const container = props.container()
    syncBounds()
    if (!active() || !container) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(container)
    window.addEventListener("resize", syncBounds)
    window.addEventListener("scroll", syncBounds, true)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", syncBounds)
      window.removeEventListener("scroll", syncBounds, true)
    })
  })

  createEffect(() => {
    const native = bridge()
    const pageId = browser.pageId()
    if (!active() || !native || !pageId) return
    const lease = claimNativeView(native, JSON.stringify([props.ownerKey, pageId]))
    let attached = false
    let shown = false
    createEffect(() => {
      const rect = bounds()
      const nextShown = visible() && Boolean(rect)
      if (!rect && !attached) return
      if (!attached || shown !== nextShown) {
        attached = true
        shown = nextShown
        void lease
          .run(() =>
            native.attachView({
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              ownerKey: props.ownerKey,
              pageId,
              ...(rect ? { bounds: rect } : {}),
              visible: nextShown,
            }),
          )
          .catch((error) => reportNativeError("attach", pageId, error))
      } else if (rect) {
        void lease
          .run(() =>
            native.resizeView({
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              ownerKey: props.ownerKey,
              pageId,
              bounds: rect,
            }),
          )
          .catch((error) => reportNativeError("resize", pageId, error))
      }
    })
    onCleanup(() => {
      void lease
        .release(() =>
          native.detachView({ protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey: props.ownerKey, pageId }),
        )
        .catch(() => undefined)
    })
  })

  createEffect(() => {
    browser.pageId()
    if (visible()) setCover(undefined)
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
