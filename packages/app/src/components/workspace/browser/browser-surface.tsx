import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"
import { NativeBrowserSurface } from "./native-browser-surface"
import { RemoteBrowserSurface } from "./remote-browser-surface"

const MIN_FIT_VIEWPORT_WIDTH = 320
const MIN_FIT_VIEWPORT_HEIGHT = 240

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
  let fileInputRef: HTMLInputElement | undefined
  let pendingFitFrame: number | undefined
  let lastFitViewportKey = ""

  const browser = useBrowser()
  const platform = usePlatform()

  const container = () => wrapperRef
  const nativePresentation = () => browser.presentation()?.kind === "native" && platform.browserNative
  const webrtcPresentation = () => browser.presentation()?.kind === "webrtc"

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
    browser.hostStatus()
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

  return (
    <div
      ref={wrapperRef}
      data-prevent-autofocus
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
        <Show when={nativePresentation()}>
          <NativeBrowserSurface
            sessionID={props.sessionID}
            routeDirectory={props.routeDirectory}
            container={container}
          />
        </Show>
        <Show when={webrtcPresentation()}>
          <RemoteBrowserSurface
            sessionID={props.sessionID}
            routeDirectory={props.routeDirectory}
            container={container}
          />
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
