import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { useBrowser, type BrowserFrameEntry } from "./browser-store"

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

export function BrowserSurface() {
  let wrapperRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let composing = false
  let pendingFitFrame: number | undefined
  let lastFitViewportKey = ""

  const browser = useBrowser()

  const activeFrame = (): BrowserFrameEntry | undefined => {
    const id = browser.activeTabId()
    if (!id) return undefined
    return browser.tabFrames[id]
  }

  createEffect(() => {
    const tabId = browser.activeTabId()
    if (tabId) browser.send({ type: "stream.start", tabId })
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
      return
    }

    const size = fitViewportSize()
    if (!size) return

    const tabId = browser.activeTabId() ?? "active"
    const key = `${tabId}:${size.width}x${size.height}`
    if (key === lastFitViewportKey) return
    lastFitViewportKey = key
    browser.setViewport(size.width, size.height, { mode: "fit" })
  }

  function scheduleFitViewport() {
    if (pendingFitFrame !== undefined) return
    pendingFitFrame = requestAnimationFrame(applyFitViewport)
  }

  createEffect(() => {
    browser.viewportMode()
    browser.activeTabId()
    scheduleFitViewport()
  })

  onMount(() => {
    if (!wrapperRef) return
    const observer = new ResizeObserver(scheduleFitViewport)
    observer.observe(wrapperRef)
    scheduleFitViewport()
    onCleanup(() => {
      observer.disconnect()
      if (pendingFitFrame !== undefined) cancelAnimationFrame(pendingFitFrame)
    })
  })

  createEffect(() => {
    const frame = activeFrame()
    const canvas = canvasRef
    if (!frame || !canvas) return

    const img = new Image()
    img.onload = () => {
      const width = frame.metadata.width || img.width
      const height = frame.metadata.height || img.height
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
    }
    img.src = frame.src
  })

  function point(e: MouseEvent | WheelEvent) {
    const canvas = canvasRef
    const frame = activeFrame()
    if (!canvas || !frame) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * frame.metadata.width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * frame.metadata.height),
    }
  }

  function handleMouse(action: "move" | "down" | "up", e: MouseEvent) {
    const tabId = browser.activeTabId()
    const p = point(e)
    if (!tabId || !p) return
    if (action === "down") {
      canvasRef?.focus()
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
    browser.send({
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
    const tabId = browser.activeTabId()
    const p = point(e)
    if (!tabId || !p) return
    browser.send({
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
    const tabId = browser.activeTabId()
    if (!tabId || composing) return
    browser.send({
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
    const tabId = browser.activeTabId()
    const text = e.clipboardData?.getData("text/plain")
    if (!tabId || !text) return
    browser.send({ type: "input.text", tabId, text })
    e.preventDefault()
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

  return (
    <div
      ref={wrapperRef}
      class="relative w-full h-full overflow-hidden bg-background-strong flex items-center justify-center"
    >
      <Show
        when={activeFrame()}
        fallback={
          <div class="flex flex-col items-center gap-3 text-text-weak text-13 select-none">
            <Icon name={getSemanticIcon("browser.main")} class="size-14 text-icon-weaker" />
            <span class="text-14-medium text-text-base">Start browsing</span>
            <span class="text-12 text-text-weak">Enter a URL to open a page</span>
            <span class="text-11 text-text-weaker">{browser.session.connectionStatus}</span>
          </div>
        }
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          class="max-w-full max-h-full outline-none cursor-default"
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
            if (tabId && text) browser.send({ type: "input.text", tabId, text })
          }}
          onPaste={handlePaste}
        />
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
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-background-stronger/70">
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
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-background-stronger/70">
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
