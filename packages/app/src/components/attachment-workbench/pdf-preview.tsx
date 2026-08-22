import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { attachmentWorkbench as A } from "@/locales/messages"
import "./pdf-viewer-vendor.css"

const PDF_MIN_SCALE = 0.5
const PDF_MAX_SCALE = 3
const PDF_SCALE_STEP = 0.25
const PDF_FIT_WIDTH_RESIZE_DEBOUNCE_MS = 100

type PdfViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs")
type PdfViewerInstance = InstanceType<PdfViewerModule["PDFViewer"]>

export function AttachmentPdfPreview(props: { bytes: Uint8Array }) {
  const lingui = useLingui()
  const [pageNumber, setPageNumber] = createSignal(1)
  const [pageCount, setPageCount] = createSignal(0)
  const [scale, setScale] = createSignal(1)
  const [fitWidth, setFitWidth] = createSignal(true)
  const [error, setError] = createSignal<string>()
  let stage!: HTMLDivElement
  let container!: HTMLDivElement
  let viewerElement!: HTMLDivElement
  let disposed = false
  let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | undefined
  let viewer: PdfViewerInstance | undefined
  let abortController: AbortController | undefined
  let resizeObserver: ResizeObserver | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    abortController = new AbortController()
    const signal = abortController.signal

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist")
        if (disposed) return
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
        // pdf_viewer.mjs reads its core API from this global, so the viewer
        // module must be imported only after the main entry has been assigned.
        const global = globalThis as { pdfjsLib?: typeof pdfjs }
        global.pdfjsLib ??= pdfjs
        const { EventBus, PDFLinkService, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs")
        if (disposed) return

        const eventBus = new EventBus()
        const linkService = new PDFLinkService({ eventBus })
        viewer = new PDFViewer({
          container,
          viewer: viewerElement,
          eventBus,
          linkService,
          abortSignal: signal,
        } as ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal })
        linkService.setViewer(viewer)

        eventBus.on(
          "pagesinit",
          () => {
            if (disposed || !viewer) return
            setPageCount(viewer.pagesCount)
            viewer.currentScaleValue = "page-width"
          },
          { signal },
        )
        eventBus.on(
          "pagechanging",
          (event: { pageNumber: number }) => {
            if (disposed) return
            setPageNumber(event.pageNumber)
          },
          { signal },
        )
        eventBus.on(
          "scalechanging",
          (event: { scale: number; presetValue?: string }) => {
            if (disposed) return
            setScale(event.scale)
            setFitWidth(event.presetValue === "page-width")
          },
          { signal },
        )

        // The viewer's own ResizeObserver only tracks container height; the
        // host must re-apply the page-width preset when the container width
        // changes (sidebar collapse, window resize, DPR change).
        resizeObserver = new ResizeObserver(() => {
          if (container.clientWidth <= 0) return
          clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            if (disposed || !viewer) return
            if (viewer.currentScaleValue === "page-width") {
              viewer.currentScaleValue = "page-width"
            }
          }, PDF_FIT_WIDTH_RESIZE_DEBOUNCE_MS)
        })
        resizeObserver.observe(container)

        loadingTask = pdfjs.getDocument({ data: props.bytes.slice() })
        const documentProxy = await loadingTask.promise
        if (disposed) return
        viewer.setDocument(documentProxy)
        linkService.setDocument(documentProxy)
      } catch (cause) {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  })

  onCleanup(() => {
    disposed = true
    clearTimeout(resizeTimer)
    resizeObserver?.disconnect()
    abortController?.abort()
    void loadingTask?.destroy()
  })

  const zoom = (direction: "in" | "out") => {
    if (!viewer) return
    const next = Math.max(
      PDF_MIN_SCALE,
      Math.min(PDF_MAX_SCALE, viewer.currentScale + (direction === "in" ? PDF_SCALE_STEP : -PDF_SCALE_STEP)),
    )
    viewer.currentScaleValue = String(next)
  }

  const toggleFitWidth = () => {
    if (!viewer) return
    viewer.currentScaleValue = viewer.currentScaleValue === "page-width" ? "1" : "page-width"
  }

  const goToPage = (delta: number) => {
    if (!viewer) return
    viewer.currentPageNumber = Math.max(1, Math.min(pageCount(), viewer.currentPageNumber + delta))
  }

  return (
    <div class="attachment-pdf-preview">
      <div class="attachment-pdf-toolbar">
        <button
          type="button"
          aria-label={lingui._(A.previousPage)}
          title={lingui._(A.previousPage)}
          disabled={pageNumber() <= 1}
          onClick={() => goToPage(-1)}
        >
          <Icon name={getSemanticIcon("navigation.back")} size="small" />
        </button>
        <span>{lingui._({ ...A.pagePosition, values: { page: pageNumber(), count: pageCount() } })}</span>
        <button
          type="button"
          aria-label={lingui._(A.nextPage)}
          title={lingui._(A.nextPage)}
          disabled={pageNumber() >= pageCount()}
          onClick={() => goToPage(1)}
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
        <button type="button" aria-pressed={fitWidth()} onClick={toggleFitWidth}>
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
      <div ref={stage} class="attachment-pdf-stage">
        <div ref={container} class="attachment-pdf-viewer-container" data-hidden={error() ? "true" : undefined}>
          <div ref={viewerElement} class="pdfViewer" />
        </div>
        <Show when={error()}>
          {(message) => <div class="attachment-workbench-error attachment-pdf-error">{message()}</div>}
        </Show>
      </div>
    </div>
  )
}
