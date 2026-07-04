import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "./icon"
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
                  <div data-slot="image-preview-title">No image selected</div>
                  <div data-slot="image-preview-meta">Image preview is unavailable.</div>
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
                aria-label="Close image preview"
                title="Close image preview"
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
                  <span>No image selected</span>
                </div>
              }
            >
              {(image) => (
                <>
                  <div data-slot="image-preview-actions" role="group" aria-label="Image actions">
                    <div data-slot="image-preview-zoom-group" role="group" aria-label="Zoom controls">
                      <button
                        type="button"
                        data-component="icon-button"
                        data-variant="ghost"
                        aria-label="Zoom out"
                        title="Zoom out"
                        disabled={!canZoomOut()}
                        onClick={() => zoom("out")}
                      >
                        <Icon name="minus" size="small" />
                      </button>
                      <button
                        type="button"
                        data-component="image-preview-zoom"
                        aria-label="Reset image view"
                        title="Reset image view"
                        onClick={resetTransform}
                      >
                        {Math.round(scale() * 100)}%
                      </button>
                      <button
                        type="button"
                        data-component="icon-button"
                        data-variant="ghost"
                        aria-label="Zoom in"
                        title="Zoom in"
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
                      aria-label="Rotate image clockwise"
                      title="Rotate image clockwise"
                      onClick={rotate}
                    >
                      <Icon name="rotate-cw" size="small" />
                    </button>
                    <a
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label="Download image"
                      title="Download image"
                      href={image().downloadUrl ?? image().src}
                      download={image().filename}
                      rel="noopener noreferrer"
                    >
                      <Icon name="download" size="small" />
                    </a>
                    <button
                      type="button"
                      data-component="icon-button"
                      data-variant="ghost"
                      aria-label="Open image in new window"
                      title="Open image in new window"
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
                      aria-label="Previous image"
                      title="Previous image"
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
                      <div data-slot="image-preview-loading">Loading image…</div>
                    </Show>
                    <Show
                      when={loadStatus() !== "error"}
                      fallback={
                        <div data-slot="image-preview-fallback">
                          <Icon name="alert-triangle" size="normal" />
                          <span data-slot="image-preview-fallback-title" title={image().filename}>
                            {image().filename}
                          </span>
                          <span>Image failed to load</span>
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
                      aria-label="Next image"
                      title="Next image"
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
