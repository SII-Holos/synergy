import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { Trans, useLingui } from "@lingui/solid"
import { usePlatform } from "@/context/platform"
import { useBrowser } from "./browser-store"
import { browser as B } from "@/locales/messages"
import { NativeBrowserSurface } from "./native-browser-surface"
import { RemoteBrowserSurface } from "./remote-browser-surface"

const MIN_FIT_VIEWPORT_WIDTH = 320
const MIN_FIT_VIEWPORT_HEIGHT = 240
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024
const MAX_UPLOAD_REQUEST_BYTES = 50 * 1024 * 1024
const MAX_UPLOAD_FILES = 20

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function BrowserSurface(props: { sessionID: string; routeDirectory?: string; ownerKey: string }) {
  let wrapperRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let pendingFitFrame: number | undefined
  let lastFitViewportKey = ""

  const browser = useBrowser()
  const platform = usePlatform()
  const lingui = useLingui()

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

    const pageId = browser.pageId() ?? "active"
    const key = `${pageId}:${size.width}x${size.height}`
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
    browser.pageId()
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
      browser.send({ type: "filechooser.select", pageId: request.pageId, requestId: request.requestId, files: [] })
      browser.setFileChooserRequest(null)
      return
    }
    const selected = Array.from(files)
    const totalBytes = selected.reduce((total, file) => total + file.size, 0)
    if (
      selected.length > MAX_UPLOAD_FILES ||
      selected.some((file) => file.size > MAX_UPLOAD_FILE_BYTES) ||
      totalBytes > MAX_UPLOAD_REQUEST_BYTES
    ) {
      browser.setBrowserError({
        severity: "error",
        code: "browser_upload_too_large",
        message: lingui._(B.uploadTooLarge.id),
      })
      return
    }
    const payload = await Promise.all(
      selected.map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
      })),
    )
    browser.send({ type: "filechooser.select", pageId: request.pageId, requestId: request.requestId, files: payload })
    browser.setFileChooserRequest(null)
  }

  function respondDialog(accept: boolean) {
    const request = browser.dialogRequest()
    if (!request) return
    browser.send({ type: "dialog.respond", pageId: request.pageId, requestId: request.requestId, accept })
    browser.setDialogRequest(null)
  }

  function hasInteractiveSurface() {
    return browser.hostStatus() === "ready" && (nativePresentation() || webrtcPresentation())
  }

  return (
    <div
      ref={wrapperRef}
      data-prevent-autofocus
      class="browser-surface relative flex h-full w-full items-center justify-center overflow-hidden"
    >
      <Show
        when={hasInteractiveSurface()}
        fallback={
          <div class="browser-empty-state">
            <div class="browser-empty-mark">
              <Icon name={getSemanticIcon("browser.main")} class="size-4" />
            </div>
            <div class="browser-empty-title">
              <Trans id={B.ready.id} message={B.ready.message} />
            </div>
            <div class="browser-empty-text">
              <Trans id={B.waitingForSurface.id} message={B.waitingForSurface.message} />
            </div>
            <div class="browser-status-pill">{browser.session.connectionStatus}</div>
          </div>
        }
      >
        <Show when={nativePresentation()}>
          <NativeBrowserSurface container={container} ownerKey={props.ownerKey} />
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
                {error().severity === "critical" ? lingui._(B.unavailable.id) : lingui._(B.issue.id)}
              </span>
              <span class="min-w-0 flex-1 truncate text-text-weak">{error().message}</span>
              <button
                type="button"
                class="text-text-weaker hover:text-text-base"
                onClick={() => browser.setBrowserError(null)}
              >
                <Trans id={B.dismiss.id} message={B.dismiss.message} />
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={browser.fileChooserRequest()}>
        {(request) => (
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-surface-overlay">
            <div class="w-[320px] rounded-lg border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
              <div class="text-13 font-medium text-text-strong">
                <Trans id={B.chooseFile.id} message={B.chooseFile.message} />
              </div>
              <div class="mt-1 text-12 text-text-weak">
                {request().multiple
                  ? lingui._({
                      id: B.chooseFilesDescription.id,
                      message: B.chooseFilesDescription.message,
                      values: { count: 2 },
                    })
                  : lingui._({
                      id: B.chooseFilesDescription.id,
                      message: B.chooseFilesDescription.message,
                      values: { count: 1 },
                    })}
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
                  <Trans id={B.cancel.id} message={B.cancel.message} />
                </Button>
                <Button size="small" variant="primary" onClick={() => fileInputRef?.click()}>
                  <Trans id={B.choose.id} message={B.choose.message} />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={browser.dialogRequest()}>
        {(request) => (
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-surface-overlay">
            <div class="w-[360px] rounded-lg border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
              <div class="text-13 font-medium text-text-strong">{request().type}</div>
              <div class="mt-2 text-12 text-text-weak whitespace-pre-wrap">{request().message}</div>
              <div class="mt-4 flex justify-end gap-2">
                <Button size="small" variant="ghost" onClick={() => respondDialog(false)}>
                  <Trans id={B.cancel.id} message={B.cancel.message} />
                </Button>
                <Button size="small" variant="primary" onClick={() => respondDialog(true)}>
                  <Trans id={B.ok.id} message={B.ok.message} />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
