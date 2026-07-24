import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useDialog } from "../context/dialog"
import { useResourceOpen } from "../context/resource-open"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import {
  clampImageIndex,
  imagePreviewMetadata,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  nextImageIndex,
  nextImageScale,
  type ImagePreviewImage,
} from "./image-preview-model"

export type { ImagePreviewImage } from "./image-preview-model"

export interface ImagePreviewProps {
  images: ImagePreviewImage[]
  initialIndex?: number
}

const noImageSelectedDescriptor = { id: "ui.imagePreview.noImageSelected", message: "No image selected" }
const imagePreviewUnavailableDescriptor = {
  id: "ui.imagePreview.unavailable",
  message: "Image preview is unavailable.",
}
const closeImagePreviewDescriptor = { id: "ui.imagePreview.close", message: "Close image preview" }
const zoomControlsDescriptor = { id: "ui.imagePreview.zoomControls", message: "Zoom controls" }
const imageActionsDescriptor = { id: "ui.imagePreview.imageActions", message: "Image actions" }
const zoomOutDescriptor = { id: "ui.imagePreview.zoomOut", message: "Zoom out" }
const zoomInDescriptor = { id: "ui.imagePreview.zoomIn", message: "Zoom in" }
const resetViewDescriptor = { id: "ui.imagePreview.resetView", message: "Reset image view" }
const rotateClockwiseDescriptor = { id: "ui.imagePreview.rotateClockwise", message: "Rotate image clockwise" }
const downloadImageDescriptor = { id: "ui.imagePreview.download", message: "Download image" }
const openNewWindowDescriptor = { id: "ui.imagePreview.openNewWindow", message: "Open image in new window" }
const openSourceDescriptor = { id: "ui.imagePreview.openSource", message: "View source in Files" }
const previousImageDescriptor = { id: "ui.imagePreview.previous", message: "Previous image" }
const nextImageDescriptor = { id: "ui.imagePreview.next", message: "Next image" }
const loadingImageDescriptor = { id: "ui.imagePreview.loading", message: "Loading image…" }
const imageLoadFailedDescriptor = { id: "ui.imagePreview.loadFailed", message: "Image failed to load" }

type LoadStatus = "loading" | "loaded" | "error"

interface PanOffset {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  originX: number
  originY: number
  startPan: PanOffset
}

export function ImagePreview(props: ImagePreviewProps) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const resourceOpen = useResourceOpen()
  const [index, setIndex] = createSignal(clampImageIndex(props.initialIndex, props.images.length))
  const [scale, setScale] = createSignal(1)
  const [pan, setPan] = createSignal<PanOffset>({ x: 0, y: 0 })
  const [drag, setDrag] = createSignal<DragState>()
  const [rotation, setRotation] = createSignal(0)
  const [loadStatus, setLoadStatus] = createSignal<LoadStatus>("loading")
  const [dimensions, setDimensions] = createSignal<{ width: number; height: number }>()

  const count = () => props.images.length
  const currentIndex = createMemo(() => clampImageIndex(index(), count()))
  const current = createMemo(() => props.images[currentIndex()])
  const canNavigate = () => count() > 1
  const canPrevious = () => currentIndex() > 0
  const canNext = () => currentIndex() < count() - 1
  const canZoomOut = () => scale() > MIN_IMAGE_SCALE
  const canZoomIn = () => scale() < MAX_IMAGE_SCALE
  const isZoomed = () => scale() > 1
  const metadata = createMemo(() => {
    const image = current()
    if (!image) return []
    return imagePreviewMetadata({ image, dimensions: dimensions(), index: currentIndex(), count: count() })
  })
  const transform = createMemo(() => {
    const offset = pan()
    return `translate(${offset.x}px, ${offset.y}px) rotate(${rotation()}deg) scale(${scale()})`
  })

  createEffect(() => {
    const clamped = clampImageIndex(props.initialIndex, props.images.length)
    setIndex(clamped)
  })

  createEffect(() => {
    current()?.id
    resetImageState()
  })

  function resetImageState() {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setDrag(undefined)
    setRotation(0)
    setLoadStatus(current() ? "loading" : "error")
    setDimensions(undefined)
  }

  function resetTransform() {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setDrag(undefined)
    setRotation(0)
  }

  function navigate(direction: "previous" | "next") {
    setIndex((value) => nextImageIndex(value, direction, count()))
  }

  function zoom(direction: "in" | "out") {
    setScale((value) => nextImageScale(value, direction))
  }

  function rotate() {
    setRotation((value) => (value + 90) % 360)
  }

  function openExternal() {
    const image = current()
    if (!image) return
    window.open(image.externalUrl ?? image.src, "_blank", "noopener,noreferrer")
  }

  function openSource() {
    const sourcePath = current()?.sourcePath
    if (!sourcePath || !resourceOpen?.openWorkspaceSource?.(sourcePath)) return
    dialog.close()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoom("in")
      return
    }
    if (event.key === "-") {
      event.preventDefault()
      zoom("out")
      return
    }
    if (event.key === "0") {
      event.preventDefault()
      resetTransform()
      return
    }
    if (event.key === "ArrowLeft" && canPrevious()) {
      event.preventDefault()
      navigate("previous")
      return
    }
    if (event.key === "ArrowRight" && canNext()) {
      event.preventDefault()
      navigate("next")
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (!isZoomed() || event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const offset = pan()
    setDrag({
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startPan: offset,
    })
  }

  function onPointerMove(event: PointerEvent) {
    const state = drag()
    if (!state || state.pointerId !== event.pointerId) return
    setPan({
      x: state.startPan.x + event.clientX - state.originX,
      y: state.startPan.y + event.clientY - state.originY,
    })
  }

  function endDrag() {
    setDrag(undefined)
  }

  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content" tabIndex={0} onKeyDown={onKeyDown}>
          <div data-slot="image-preview-header">
            <Show
              when={current()}
              fallback={
                <div data-slot="image-preview-title-group">
                  <div data-slot="image-preview-title">{_(noImageSelectedDescriptor)}</div>
                  <div data-slot="image-preview-meta">{_(imagePreviewUnavailableDescriptor)}</div>
                </div>
              }
            >
              {(image) => (
                <div data-slot="image-preview-title-group">
                  <div data-slot="image-preview-title" title={image().filename}>
                    {image().filename}
                  </div>
                  <div data-slot="image-preview-meta">
                    <For each={metadata()}>{(item) => <span>{item}</span>}</For>
                  </div>
                </div>
              )}
            </Show>
            <div data-slot="image-preview-toolbar">
              <Kobalte.CloseButton
                data-slot="image-preview-close"
                data-component="icon-button"
                data-variant="ghost"
                aria-label={_(closeImagePreviewDescriptor)}
                title={_(closeImagePreviewDescriptor)}
              >
                <Icon name="x" size="small" />
              </Kobalte.CloseButton>
            </div>
          </div>
          <div data-slot="image-preview-body">
            <Show
              when={current()}
              fallback={
                <div data-slot="image-preview-fallback">
                  <Icon name="image" size="normal" />
                  <span>{_(noImageSelectedDescriptor)}</span>
                </div>
              }
            >
              {(image) => (
                <>
                  <div data-slot="image-preview-actions" role="group" aria-label={_(imageActionsDescriptor)}>
                    <div data-slot="image-preview-zoom-group" role="group" aria-label={_(zoomControlsDescriptor)}>
                      <button
                        type="button"
                        data-component="icon-button"
                        data-variant="ghost"
                        aria-label={_(zoomOutDescriptor)}
                        title={_(zoomOutDescriptor)}
                        disabled={!canZoomOut()}
                        onClick={() => zoom("out")}
                      >
                        <Icon name="minus" size="small" />
                      </button>
                      <button
                        type="button"
                        data-component="image-preview-zoom"
                        aria-label={_(resetViewDescriptor)}
                        title={_(resetViewDescriptor)}
                        onClick={resetTransform}
                      >
                        {Math.round(scale() * 100)}%
                      </button>
                      <button
                        type="button"
                        data-component="icon-button"
                        data-variant="ghost"
                        aria-label={_(zoomInDescriptor)}
                        title={_(zoomInDescriptor)}
                        disabled={!canZoomIn()}
                        onClick={() => zoom("in")}
                      >
                        <Icon name="plus" size="small" />
                      </button>
                    </div>
                    <button
                      type="button"
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label={_(rotateClockwiseDescriptor)}
                      title={_(rotateClockwiseDescriptor)}
                      onClick={rotate}
                    >
                      <Icon name="rotate-cw" size="small" />
                    </button>
                    <a
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label={_(downloadImageDescriptor)}
                      title={_(downloadImageDescriptor)}
                      href={image().downloadUrl ?? image().src}
                      download={image().filename}
                      rel="noopener noreferrer"
                    >
                      <Icon name="download" size="small" />
                    </a>
                    <Show when={resourceOpen?.openWorkspaceSource ? current()?.sourcePath : undefined}>
                      <button
                        type="button"
                        data-component="icon-button"
                        data-variant="ghost"
                        aria-label={_(openSourceDescriptor)}
                        title={_(openSourceDescriptor)}
                        onClick={openSource}
                      >
                        <Icon name={getSemanticIcon("workspace.files")} size="small" />
                      </button>
                    </Show>
                    <button
                      type="button"
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label={_(openNewWindowDescriptor)}
                      title={_(openNewWindowDescriptor)}
                      onClick={openExternal}
                    >
                      <Icon name="arrow-up-right" size="small" />
                    </button>
                  </div>
                  <Show when={canNavigate()}>
                    <button
                      type="button"
                      data-slot="image-preview-nav"
                      data-side="left"
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label={_(previousImageDescriptor)}
                      title={_(previousImageDescriptor)}
                      disabled={!canPrevious()}
                      onClick={() => navigate("previous")}
                    >
                      <Icon name="arrow-left" size="small" />
                    </button>
                  </Show>
                  <div
                    data-slot="image-preview-stage"
                    data-zoomed={isZoomed() ? "true" : "false"}
                    data-dragging={drag() ? "true" : "false"}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                  >
                    <Show when={loadStatus() === "loading"}>
                      <div data-slot="image-preview-loading">{_(loadingImageDescriptor)}</div>
                    </Show>
                    <Show
                      when={loadStatus() !== "error"}
                      fallback={
                        <div data-slot="image-preview-fallback">
                          <Icon name="alert-triangle" size="normal" />
                          <span data-slot="image-preview-fallback-title" title={image().filename}>
                            {image().filename}
                          </span>
                          <span>{_(imageLoadFailedDescriptor)}</span>
                        </div>
                      }
                    >
                      <img
                        src={image().src}
                        alt={image().alt ?? image().filename}
                        data-slot="image-preview-image"
                        style={{ transform: transform() }}
                        onLoad={(event) => {
                          const img = event.currentTarget
                          setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                          setLoadStatus("loaded")
                        }}
                        onError={() => setLoadStatus("error")}
                      />
                    </Show>
                  </div>
                  <Show when={canNavigate()}>
                    <button
                      type="button"
                      data-slot="image-preview-nav"
                      data-side="right"
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label={_(nextImageDescriptor)}
                      title={_(nextImageDescriptor)}
                      disabled={!canNext()}
                      onClick={() => navigate("next")}
                    >
                      <Icon name="arrow-right" size="small" />
                    </button>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
