import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useBrowser } from "./browser-store"
import { BrowserWebRTCClient, createBrowserWebRTCSignalingUrl, type BrowserWebRTCStatus } from "./browser-webrtc"

const MIN_FIT_VIEWPORT_WIDTH = 320
const MIN_FIT_VIEWPORT_HEIGHT = 240

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
}

function modifiers(e: KeyboardEvent | MouseEvent | WheelEvent): string[] {
  const result: string[] = []
  if (e.altKey) result.push("Alt")
  if (e.ctrlKey) result.push("Control")
  if (e.metaKey) result.push("Meta")
  if (e.shiftKey) result.push("Shift")
  return result
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function BrowserSurface(props: { sessionID: string; routeDirectory?: string }) {
  let wrapperRef: HTMLDivElement | undefined
  let videoRef: HTMLVideoElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let webrtcClient: BrowserWebRTCClient | null = null
  let composing = false
  let pendingFitFrame: number | undefined
  let lastFitViewportKey = ""
  let lastWebRTCResizeKey = ""

  const browser = useBrowser()
  const platform = usePlatform()
  const sdk = useSDK()
  const [webrtcStatus, setWebrtcStatus] = createSignal<BrowserWebRTCStatus>("idle")
  const [webrtcDetail, setWebrtcDetail] = createSignal<unknown>(null)

  const nativePresentation = () => {
    return browser.presentation()?.kind === "native" && platform.browserNative
  }

  const webrtcPresentation = () => {
    return browser.presentation()?.kind === "webrtc"
  }

  createEffect(() => {
    const tabId = browser.activeTabId()
    if (!webrtcPresentation() || !tabId) return

    const signalingUrl = createBrowserWebRTCSignalingUrl({
      serverUrl: sdk.url,
      sessionID: props.sessionID,
      tabId,
      routeDirectory: props.routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      client: platform.platform === "desktop" ? "desktop" : "web",
      sameHost: platform.platform === "desktop",
      traceId: browser.browserTraceId(),
    })

    if (!signalingUrl) {
      setWebrtcStatus("error")
      setWebrtcDetail({ message: "Missing browser signaling route" })
      return
    }

    const client = new BrowserWebRTCClient({
      signalingUrl,
      tabId,
      onStatus: (status, detail) => {
        setWebrtcStatus(status)
        setWebrtcDetail(detail ?? null)
        if (status === "host_pending") browser.setHostStatus(tabId, "pending")
      },
      onStream: (stream) => {
        if (!videoRef) return
        videoRef.srcObject = stream
        void videoRef.play().catch(() => {})
      },
      onMessage: (message) => {
        if (typeof message !== "object" || message === null) return
        const msg = message as { type?: unknown; tabId?: unknown; status?: unknown }
        if (msg.type !== "browser.host.status") return
        if (typeof msg.tabId !== "string") return
        if (
          msg.status === "pending" ||
          msg.status === "ready" ||
          msg.status === "detached" ||
          msg.status === "restarting" ||
          msg.status === "failed"
        ) {
          browser.setHostStatus(msg.tabId, msg.status)
        }
      },
    })
    webrtcClient = client
    void client.connect().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      setWebrtcStatus("error")
      setWebrtcDetail({ message })
    })

    onCleanup(() => {
      if (webrtcClient === client) webrtcClient = null
      client.close()
      if (videoRef?.srcObject instanceof MediaStream) {
        for (const track of videoRef.srcObject.getTracks()) track.stop()
      }
      if (videoRef) videoRef.srcObject = null
      setWebrtcStatus("idle")
      setWebrtcDetail(null)
    })
  })

  function fitViewportSize() {
    if (!wrapperRef) return null
    const rect = wrapperRef.getBoundingClientRect()
    const width = Math.max(MIN_FIT_VIEWPORT_WIDTH, Math.round(rect.width))
    const height = Math.max(MIN_FIT_VIEWPORT_HEIGHT, Math.round(rect.height))
    if (width <= 0 || height <= 0) return null
    return { width, height }
  }

  function applyFitViewport() {
    pendingFitFrame = undefined
    if (browser.viewportMode() !== "fit") {
      lastFitViewportKey = ""
      syncNativeBounds()
      return
    }

    const size = fitViewportSize()
    if (!size) return

    const tabId = browser.activeTabId() ?? "active"
    const key = `${tabId}:${size.width}x${size.height}`
    if (key === lastFitViewportKey) return
    lastFitViewportKey = key
    browser.setViewport(size.width, size.height, { mode: "fit" })
    syncNativeBounds()
  }

  function scheduleFitViewport() {
    if (pendingFitFrame !== undefined) return
    pendingFitFrame = requestAnimationFrame(applyFitViewport)
  }

  createEffect(() => {
    browser.viewportMode()
    browser.activeTabId()
    browser.hostStatus()
    scheduleFitViewport()
  })

  createEffect(() => {
    if (!webrtcPresentation()) {
      lastWebRTCResizeKey = ""
      return
    }
    const tabId = browser.activeTabId()
    const width = browser.viewportWidth()
    const height = browser.viewportHeight()
    webrtcStatus()
    if (!tabId) return
    const key = `${tabId}:${width}x${height}`
    if (key === lastWebRTCResizeKey) return
    if (webrtcClient?.sendInput({ type: "input.resize", tabId, width, height })) {
      lastWebRTCResizeKey = key
    }
  })

  function syncNativeNavigation(tabId: string, url?: string) {
    if (!url || url === "about:blank") return
    const tab = browser.session.tabs.find((item) => item.id === tabId)
    if (tab?.url === url) return
    browser.send({ type: "navigate", source: "user", tabId, url })
  }

  onMount(() => {
    if (!wrapperRef) return
    const observer = new ResizeObserver(scheduleFitViewport)
    observer.observe(wrapperRef)
    scheduleFitViewport()
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
    onCleanup(() => {
      unsubscribeNative?.()
      observer.disconnect()
      if (pendingFitFrame !== undefined) cancelAnimationFrame(pendingFitFrame)
    })
  })

  createEffect(() => {
    const bridge = nativePresentation()
    const tab = browser.activeTab()
    if (!bridge || !tab || !wrapperRef) return

    const rect = wrapperRef.getBoundingClientRect()
    void bridge.attachView({
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

  onCleanup(() => {
    const tabId = browser.activeTabId()
    if (tabId) void platform.browserNative?.detachView({ tabId })
  })

  function syncNativeBounds() {
    const bridge = nativePresentation()
    const tabId = browser.activeTabId()
    if (!bridge || !tabId || !wrapperRef) return
    const rect = wrapperRef.getBoundingClientRect()
    void bridge.resizeView({
      tabId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })
  }

  function point(e: MouseEvent | WheelEvent) {
    const target = videoRef ?? wrapperRef
    if (!target) return null
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const width = videoRef?.videoWidth || browser.viewportWidth()
    const height = videoRef?.videoHeight || browser.viewportHeight()
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * height),
    }
  }

  function sendInteractiveInput(payload: Record<string, unknown>) {
    if (webrtcPresentation()) {
      webrtcClient?.sendInput(payload)
      return
    }
    browser.send(payload)
  }

  function handleMouse(action: "move" | "down" | "up", e: MouseEvent) {
    if (nativePresentation()) return
    const tabId = browser.activeTabId()
    const p = point(e)
    if (!tabId || !p) return
    if (action === "down") {
      videoRef?.focus()
      if (browser.annotationMode()) {
        const wrapper = wrapperRef?.getBoundingClientRect()
        browser.setAnnotationTarget({
          displayX: wrapper ? Math.round(e.clientX - wrapper.left) : p.x,
          displayY: wrapper ? Math.round(e.clientY - wrapper.top) : p.y,
          pageX: p.x,
          pageY: p.y,
        })
        e.preventDefault()
        return
      }
    }
    sendInteractiveInput({
      type: "input.mouse",
      action,
      tabId,
      x: p.x,
      y: p.y,
      button: mouseButton(e.button),
      clickCount: e.detail || 1,
      modifiers: modifiers(e),
    })
    e.preventDefault()
  }

  function handleWheel(e: WheelEvent) {
    if (nativePresentation()) return
    const tabId = browser.activeTabId()
    const p = point(e)
    if (!tabId || !p) return
    sendInteractiveInput({
      type: "input.mouse",
      action: "wheel",
      tabId,
      x: p.x,
      y: p.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiers(e),
    })
    e.preventDefault()
  }

  function handleKey(action: "down" | "up", e: KeyboardEvent) {
    if (nativePresentation()) return
    const tabId = browser.activeTabId()
    if (!tabId || composing) return
    sendInteractiveInput({
      type: "input.key",
      action,
      tabId,
      key: e.key,
      code: e.code,
      text: e.key.length === 1 ? e.key : undefined,
      autoRepeat: e.repeat,
      modifiers: modifiers(e),
    })
    e.preventDefault()
  }

  function handlePaste(e: ClipboardEvent) {
    if (nativePresentation()) return
    const tabId = browser.activeTabId()
    const text = e.clipboardData?.getData("text/plain")
    if (!tabId || !text) return
    sendInteractiveInput({ type: "input.text", tabId, text })
    e.preventDefault()
  }

  function focusNativeView() {
    const tabId = browser.activeTabId()
    if (!tabId) return
    void platform.browserNative?.focusView({ tabId })
  }

  async function chooseFiles(files: FileList | null) {
    const request = browser.fileChooserRequest()
    if (!request) return
    if (!files || files.length === 0) {
      browser.send({ type: "filechooser.select", tabId: request.tabId, requestId: request.requestId, files: [] })
      browser.setFileChooserRequest(null)
      return
    }
    const payload = await Promise.all(
      Array.from(files).map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        data: arrayBufferToBase64(await file.arrayBuffer()),
      })),
    )
    browser.send({ type: "filechooser.select", tabId: request.tabId, requestId: request.requestId, files: payload })
    browser.setFileChooserRequest(null)
  }

  function respondDialog(accept: boolean) {
    const request = browser.dialogRequest()
    if (!request) return
    browser.send({ type: "dialog.respond", tabId: request.tabId, requestId: request.requestId, accept })
    browser.setDialogRequest(null)
  }

  function hasInteractiveSurface() {
    return nativePresentation() || webrtcPresentation()
  }

  function webrtcStatusMessage() {
    const detail = webrtcDetail()
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      return String((detail as { message: unknown }).message)
    }
    if (webrtcStatus() === "host_pending") return "Waiting for Browser Host"
    if (webrtcStatus() === "host_ready") return "Preparing remote browser stream"
    if (webrtcStatus() === "negotiating") return "Negotiating remote browser stream"
    if (webrtcStatus() === "signaling") return "Connecting to remote browser"
    if (webrtcStatus() === "error") return "Remote browser stream unavailable"
    return "Preparing remote browser"
  }

  function streamReady() {
    return webrtcStatus() === "stream_ready"
  }

  return (
    <div
      ref={wrapperRef}
      class="relative w-full h-full overflow-hidden bg-background-strong flex items-center justify-center"
    >
      <Show
        when={hasInteractiveSurface()}
        fallback={
          <div class="flex flex-col items-center gap-3 text-text-weak text-13 select-none">
            <Icon name={getSemanticIcon("browser.main")} class="size-14 text-icon-weaker" />
            <span class="text-14-medium text-text-base">Start browsing</span>
            <span class="text-12 text-text-weak">Enter a URL to open a page</span>
            <span class="text-11 text-text-weaker">{browser.session.connectionStatus}</span>
          </div>
        }
      >
        <Show when={!nativePresentation()} fallback={<div class="absolute inset-0" onPointerDown={focusNativeView} />}>
          <Show when={webrtcPresentation()}>
            <video
              ref={videoRef}
              tabIndex={0}
              autoplay
              playsinline
              muted
              class="max-w-full max-h-full outline-none cursor-default bg-background-strong"
              onMouseMove={(e) => handleMouse("move", e)}
              onMouseDown={(e) => handleMouse("down", e)}
              onMouseUp={(e) => handleMouse("up", e)}
              onWheel={handleWheel}
              onKeyDown={(e) => handleKey("down", e)}
              onKeyUp={(e) => handleKey("up", e)}
              onCompositionStart={() => {
                composing = true
              }}
              onCompositionEnd={(e) => {
                composing = false
                const text = e.data
                const tabId = browser.activeTabId()
                if (tabId && text) sendInteractiveInput({ type: "input.text", tabId, text })
              }}
              onPaste={handlePaste}
            />
            <Show when={!streamReady()}>
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background-strong/80 text-center text-text-weak">
                <Icon name={getSemanticIcon("browser.main")} class="size-10 text-icon-weaker" />
                <span class="text-13-medium text-text-base">{webrtcStatusMessage()}</span>
                <span class="text-11 text-text-weaker">{webrtcStatus()}</span>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>

      <Show when={browser.browserError()}>
        {(error) => (
          <div class="absolute left-3 right-3 top-3 z-40 rounded-md border border-border-weak-base bg-surface-raised-stronger-non-alpha px-3 py-2 text-12 text-text-strong shadow-sm">
            <div class="flex items-center gap-2">
              <span class="font-medium">
                {error().severity === "critical" ? "Browser unavailable" : "Browser issue"}
              </span>
              <span class="min-w-0 flex-1 truncate text-text-weak">{error().message}</span>
              <button
                type="button"
                class="text-text-weaker hover:text-text-base"
                onClick={() => browser.setBrowserError(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={browser.fileChooserRequest()}>
        {(request) => (
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/45">
            <div class="w-[320px] rounded-lg border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
              <div class="text-13 font-medium text-text-strong">Choose file for upload</div>
              <div class="mt-1 text-12 text-text-weak">
                The page requested {request().multiple ? "one or more files" : "a file"}.
              </div>
              <input
                ref={fileInputRef}
                type="file"
                class="hidden"
                multiple={request().multiple}
                accept={request().accept.join(",")}
                onChange={(e) => void chooseFiles(e.currentTarget.files)}
              />
              <div class="mt-4 flex justify-end gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    void chooseFiles(null)
                  }}
                >
                  Cancel
                </Button>
                <Button size="small" variant="primary" onClick={() => fileInputRef?.click()}>
                  Choose
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={browser.dialogRequest()}>
        {(request) => (
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/45">
            <div class="w-[360px] rounded-lg border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
              <div class="text-13 font-medium text-text-strong">{request().type}</div>
              <div class="mt-2 text-12 text-text-weak whitespace-pre-wrap">{request().message}</div>
              <div class="mt-4 flex justify-end gap-2">
                <Button size="small" variant="ghost" onClick={() => respondDialog(false)}>
                  Cancel
                </Button>
                <Button size="small" variant="primary" onClick={() => respondDialog(true)}>
                  OK
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
