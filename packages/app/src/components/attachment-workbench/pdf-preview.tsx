import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { attachmentWorkbench as A } from "@/locales/messages"
import { createPdfRenderCoordinator } from "./pdf-render"

const PDF_MIN_SCALE = 0.5
const PDF_MAX_SCALE = 3
const PDF_SCALE_STEP = 0.25

export function AttachmentPdfPreview(props: { bytes: Uint8Array }) {
  const lingui = useLingui()
  const [document, setDocument] = createSignal<import("pdfjs-dist").PDFDocumentProxy>()
  const [page, setPage] = createSignal(1)
  const [scale, setScale] = createSignal(1)
  const [fitWidth, setFitWidth] = createSignal(true)
  const [hostWidth, setHostWidth] = createSignal(0)
  const [error, setError] = createSignal<string>()
  let host!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | undefined
  let observer: ResizeObserver | undefined
  let disposed = false
  const renderer = createPdfRenderCoordinator<import("pdfjs-dist").PDFPageProxy>()

  onMount(() => {
    observer = new ResizeObserver(([entry]) => setHostWidth(entry?.contentRect.width ?? 0))
    observer.observe(host)

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist")
        if (disposed) return
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
        loadingTask = pdfjs.getDocument({ data: props.bytes.slice() })
        const loaded = await loadingTask.promise
        if (disposed) return
        setDocument(loaded)
      } catch (cause) {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  })

  createEffect(() => {
    const pdf = document()
    const pageNumber = page()
    const requestedScale = scale()
    const width = hostWidth()
    const shouldFit = fitWidth()
    if (!pdf || !canvas || (shouldFit && width <= 0)) {
      renderer.cancel()
      return
    }

    setError(undefined)
    void renderer.render({
      loadPage: () => pdf.getPage(pageNumber),
      drawPage: (pdfPage) => {
        const base = pdfPage.getViewport({ scale: 1 })
        const effectiveScale = shouldFit
          ? Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, (width - 32) / base.width))
          : requestedScale
        const viewport = pdfPage.getViewport({ scale: effectiveScale })
        const ratio = window.devicePixelRatio || 1
        const context = canvas.getContext("2d")
        if (!context) {
          return {
            promise: Promise.resolve(),
            cancel() {},
          }
        }
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        return pdfPage.render({ canvas, canvasContext: context, viewport })
      },
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    })
  })

  onCleanup(() => {
    disposed = true
    observer?.disconnect()
    renderer.cancel()
    void loadingTask?.destroy()
  })

  const pageCount = () => document()?.numPages ?? 0
  const zoom = (direction: "in" | "out") => {
    setFitWidth(false)
    setScale((value) =>
      Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, value + (direction === "in" ? PDF_SCALE_STEP : -PDF_SCALE_STEP))),
    )
  }

  return (
    <div class="attachment-pdf-preview">
      <div class="attachment-pdf-toolbar">
        <button
          type="button"
          aria-label={lingui._(A.previousPage)}
          title={lingui._(A.previousPage)}
          disabled={page() <= 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          <Icon name={getSemanticIcon("navigation.back")} size="small" />
        </button>
        <span>{lingui._({ ...A.pagePosition, values: { page: page(), count: pageCount() } })}</span>
        <button
          type="button"
          aria-label={lingui._(A.nextPage)}
          title={lingui._(A.nextPage)}
          disabled={page() >= pageCount()}
          onClick={() => setPage((value) => Math.min(pageCount(), value + 1))}
        >
          <Icon name={getSemanticIcon("navigation.forward")} size="small" />
        </button>
        <span class="attachment-pdf-toolbar-spacer" />
        <button
          type="button"
          aria-label={lingui._(A.zoomOut)}
          title={lingui._(A.zoomOut)}
          disabled={!fitWidth() && scale() <= PDF_MIN_SCALE}
          onClick={() => zoom("out")}
        >
          <Icon name={getSemanticIcon("action.zoomOut")} size="small" />
        </button>
        <button type="button" aria-pressed={fitWidth()} onClick={() => setFitWidth(true)}>
          {lingui._(A.fitWidth)}
        </button>
        <button
          type="button"
          aria-label={lingui._(A.zoomIn)}
          title={lingui._(A.zoomIn)}
          disabled={!fitWidth() && scale() >= PDF_MAX_SCALE}
          onClick={() => zoom("in")}
        >
          <Icon name={getSemanticIcon("action.zoomIn")} size="small" />
        </button>
      </div>
      <div ref={host} class="attachment-pdf-stage">
        <canvas ref={canvas} data-hidden={error() ? "true" : undefined} />
        <Show when={error()}>{(message) => <div class="attachment-workbench-error">{message()}</div>}</Show>
      </div>
    </div>
  )
}
