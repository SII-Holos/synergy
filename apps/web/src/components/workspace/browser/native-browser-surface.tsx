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

const COVER_CAPTURE_TIMEOUT_MS = 400
const COVER_SETTLE_MS = 250

type BrowserCover = { pageId: string; url: string; dataUrl: string }

export function shouldCaptureCover(input: {
  visible: boolean
  hostReady: boolean
  hasBounds: boolean
  page?: { status?: string; isLoading?: boolean; url?: string } | null
}) {
  const page = input.page
  if (!input.visible || !input.hostReady || !input.hasBounds || !page) return false
  return page.status === "active" && page.isLoading !== true && Boolean(page.url) && page.url !== "about:blank"
}

export function coverMatchesPage(
  cover: { pageId: string; url: string } | undefined,
  page: { id: string; url: string } | null,
) {
  return Boolean(cover && page && cover.pageId === page.id && cover.url === page.url)
}

export function NativeBrowserSurface(props: { container: () => HTMLDivElement | undefined; ownerKey: string }) {
  const active = useViewActivity()
  const browser = useBrowser()
  const dialog = useDialog()
  const platform = usePlatform()
  const workspaceMenuOpen = useContext(WorkbenchSurfaceOverlay)
  const [cover, setCover] = createSignal<BrowserCover>()
  const [coverPending, setCoverPending] = createSignal(false)
  const [bounds, setBounds] = createSignal<ReturnType<typeof nativeBounds>>(null, {
    equals: (left, right) =>
      left?.x === right?.x && left?.y === right?.y && left?.width === right?.width && left?.height === right?.height,
  })
  let disposed = false
  let captureSequence = 0
  let activeCapture: { pageId: string; promise: Promise<boolean> } | undefined

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
  const nativeVisible = createMemo(() => visible() || coverPending())

  function syncBounds() {
    const container = props.container()
    setBounds(active() && container ? nativeBounds(container.getBoundingClientRect()) : null)
  }

  // Native views sit above the renderer; overlays reveal the decoded still already painted underneath.
  async function captureCover(pageId: string): Promise<boolean> {
    const pageAction = platform.browserNative?.pageAction
    if (!pageAction) return false
    const sequence = ++captureSequence
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const capture = async () => {
        const result = await pageAction({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: props.ownerKey,
          pageId,
          action: { type: "cover" },
        })
        if (result.type !== "cover") return
        const image = new Image()
        image.src = result.dataUrl
        await image.decode()
        return { pageId, url: result.url, dataUrl: result.dataUrl }
      }
      const result = await Promise.race([
        capture().catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), COVER_CAPTURE_TIMEOUT_MS)
        }),
      ])
      if (disposed || sequence !== captureSequence || !coverMatchesPage(result, browser.page())) return false
      setCover(result)
      return true
    } finally {
      clearTimeout(timer)
    }
  }

  function requestCover(pageId: string) {
    if (activeCapture?.pageId === pageId) return activeCapture.promise
    const promise = captureCover(pageId).catch(() => false)
    const capture = { pageId, promise }
    activeCapture = capture
    void promise.then(
      () => {
        if (activeCapture === capture) activeCapture = undefined
      },
      () => {
        if (activeCapture === capture) activeCapture = undefined
      },
    )
    return promise
  }

  function invalidateCapture(pageId: string) {
    captureSequence++
    if (activeCapture?.pageId === pageId) activeCapture = undefined
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
          if (coverMatchesPage(event, browser.page())) setCover(event)
          break
        }
        case "native.page": {
          browser.upsertPage(event.page)
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
    const pageId = browser.pageId()
    const page = browser.page()
    const native = bridge()
    if (
      !active() ||
      !native?.pageAction ||
      browser.hostStatus() !== "ready" ||
      !bounds() ||
      !pageId ||
      !page ||
      visible() ||
      coverMatchesPage(cover(), page)
    )
      return

    let cancelled = false
    setCoverPending(true)
    void requestCover(pageId).then(() => {
      if (!cancelled && browser.pageId() === pageId) setCoverPending(false)
    })
    onCleanup(() => {
      cancelled = true
      setCoverPending(false)
      invalidateCapture(pageId)
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
      const nextShown = nativeVisible() && Boolean(rect)
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
    const pageId = browser.pageId()
    const page = browser.page()
    if (!pageId) return
    const ready = shouldCaptureCover({
      visible: visible(),
      hostReady: browser.hostStatus() === "ready",
      hasBounds: Boolean(bounds()),
      page,
    })
    if (!ready) return
    if (coverMatchesPage(cover(), page)) return
    let started = false
    const timer = setTimeout(() => {
      if (disposed || !visible() || browser.pageId() !== pageId) return
      started = true
      void requestCover(pageId)
    }, COVER_SETTLE_MS)
    onCleanup(() => {
      clearTimeout(timer)
      if (started) invalidateCapture(pageId)
    })
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
      <Show when={coverMatchesPage(cover(), browser.page())}>
        <img src={cover()?.dataUrl} alt="" aria-hidden="true" class="pointer-events-none h-full w-full object-fill" />
      </Show>
    </div>
  )
}
