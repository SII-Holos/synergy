import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { useLingui } from "@lingui/solid"
import { createFocusScope } from "@kobalte/core/primitives/create-focus-scope"
import { OverlayLayerProvider } from "../context/overlay-layer"
import { useViewActivity } from "../context/view-activity"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { clampImageIndex, imagePreviewMetadata, type ImagePreviewImage } from "./image-preview-model"
import { ImageViewerControls, type ImageViewerCommand } from "./image-viewer-controls"
import type { ImageViewerActions } from "./image-viewer-actions"
import {
  actualImageViewer,
  applyImageViewerKey,
  applyImageViewerWheel,
  createImageViewerState,
  fitImageViewer,
  imageViewerDisplayRect,
  imageViewerEntryKey,
  imageViewerScaleBounds,
  imageViewerZoomPercent,
  panImageViewer,
  resizeImageViewer,
  resolveImageViewerKey,
  rotateImageViewer,
  setImageViewerImage,
  stepImageViewerZoom,
  zoomImageViewerAt,
  type ImageViewerOffset,
  type ImageViewerState,
} from "./image-viewer-model"
import "./image-viewer.css"

export type { ImageViewerActions, ImageViewerActionResult } from "./image-viewer-actions"
export interface ImageViewerProps {
  images: readonly ImagePreviewImage[]
  initialIndex?: number
  initialScaleMode?: "fit" | "actual"
  onScaleModeChange?: (mode: "fit" | "actual") => void
  onImageChange?: (image: ImagePreviewImage | undefined) => void
  actions?: ImageViewerActions
  onOpenSource?: (image: ImagePreviewImage, signal: AbortSignal) => Promise<void> | void
}

const copy = {
  fit: { id: "ui.imagePreview.fit", message: "Fit image" },
  fitLabel: { id: "ui.imagePreview.fitLabel", message: "Fit" },
  actual: { id: "ui.imagePreview.actual", message: "Actual size (1:1)" },
  zoomIn: { id: "ui.imagePreview.zoomIn", message: "Zoom in" },
  zoomOut: { id: "ui.imagePreview.zoomOut", message: "Zoom out" },
  rotate: { id: "ui.imagePreview.rotateClockwise", message: "Rotate image clockwise" },
  copy: { id: "ui.imagePreview.copy", message: "Copy image" },
  save: { id: "ui.imagePreview.save", message: "Save image" },
  copyLink: { id: "ui.imagePreview.copyLink", message: "Copy image link" },
  openExternal: { id: "ui.imagePreview.openExternal", message: "Open in system browser" },
  source: { id: "ui.imagePreview.openSource", message: "View source in Files" },
  fullscreen: { id: "ui.imagePreview.fullscreen", message: "Enter fullscreen" },
  exitFullscreen: { id: "ui.imagePreview.exitFullscreen", message: "Exit fullscreen" },
  background: { id: "ui.imagePreview.background", message: "Transparency grid" },
  thumbnails: { id: "ui.imagePreview.thumbnails", message: "Thumbnails" },
  menu: { id: "ui.imagePreview.imageActions", message: "Image actions" },
  loading: { id: "ui.imagePreview.loading", message: "Loading image…" },
  failed: { id: "ui.imagePreview.loadFailed", message: "Image failed to load" },
  retry: { id: "ui.imagePreview.retry", message: "Retry" },
  empty: { id: "ui.imagePreview.noImageSelected", message: "No image selected" },
  previous: { id: "ui.imagePreview.previous", message: "Previous image" },
  next: { id: "ui.imagePreview.next", message: "Next image" },
  busy: { id: "ui.imagePreview.working", message: "Working…" },
  copied: { id: "ui.imagePreview.copied", message: "Image copied" },
  linkCopied: { id: "ui.imagePreview.linkCopied", message: "Link copied" },
  saved: { id: "ui.imagePreview.saved", message: "Image saved" },
  downloaded: { id: "ui.imagePreview.downloadStarted", message: "Download started" },
  opened: { id: "ui.imagePreview.opened", message: "Opening in system browser" },
  cancelled: { id: "ui.imagePreview.cancelled", message: "Cancelled" },
  actionFailed: { id: "ui.imagePreview.actionFailed", message: "Action failed. Try again." },
}

export function ImageViewer(props: ImageViewerProps) {
  const { _ } = useLingui()
  const active = useViewActivity()
  let root!: HTMLDivElement
  let stage!: HTMLDivElement
  const [portal, setPortal] = createSignal<HTMLElement>()
  const [index, setIndex] = createSignal(clampImageIndex(props.initialIndex, props.images.length))
  createComputed(() => {
    const length = props.images.length
    setIndex((value) => clampImageIndex(value, length))
  })
  const current = createMemo(() => props.images[index()])
  const key = () => (current() ? imageViewerEntryKey(current()!) : "")
  const [view, setView] = createSignal(
    createImageViewerState({
      viewport: { width: 0, height: 0 },
      mode: props.initialScaleMode === "actual" ? "free" : "fit",
    }),
  )
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")
  const [attempt, setAttempt] = createSignal(0)
  const [grid, setGrid] = createSignal(true)
  const [thumbnails, setThumbnails] = createSignal(true)
  const [fullscreen, setFullscreen] = createSignal(false)
  // Fullscreen excludes the modal's outer sentinels; share its focus-scope stack inside the viewer.
  createFocusScope({ trapFocus: true, onUnmountAutoFocus: (event) => event.preventDefault() }, () =>
    fullscreen() ? root : undefined,
  )
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [contextOpen, setContextOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; error?: boolean }>()
  const [dragging, setDragging] = createSignal(false)
  const views = new Map<string, ImageViewerState>()
  const pointers = new Map<number, ImageViewerOffset>()
  let action: AbortController | undefined
  let selectedKey = ""
  const ready = () => status() === "ready"
  const bounds = () => imageViewerScaleBounds(view())
  const canPan = () => {
    const rect = imageViewerDisplayRect(view())
    return rect.width > view().viewport.width || rect.height > view().viewport.height
  }
  const metadata = () =>
    current()
      ? imagePreviewMetadata({
          image: current()!,
          dimensions: ready() ? view().image : undefined,
          index: index(),
          count: props.images.length,
        }).join(" · ")
      : ""
  const resetInput = () => {
    pointers.clear()
    setDragging(false)
  }
  const setMode = (mode: "fit" | "actual") => {
    setView(mode === "fit" ? fitImageViewer : actualImageViewer)
    props.onScaleModeChange?.(mode)
  }
  createComputed(
    on(key, (next) => {
      if (selectedKey && untrack(ready)) views.set(selectedKey, untrack(view))
      action?.abort()
      setBusy(false)
      setNotice(undefined)
      setMenuOpen(false)
      setContextOpen(false)
      resetInput()
      selectedKey = next
      const viewport = untrack(view).viewport
      setView(
        views.has(next)
          ? resizeImageViewer(views.get(next)!, viewport)
          : createImageViewerState({ viewport, mode: props.initialScaleMode === "actual" ? "free" : "fit" }),
      )
      setStatus("loading")
      setAttempt(0)
      const present = new Set(props.images.map(imageViewerEntryKey))
      for (const entry of views.keys()) if (!present.has(entry)) views.delete(entry)
    }),
  )
  createEffect(() => props.onImageChange?.(current()))
  createEffect(() => {
    current()
    if (!active() || !thumbnails()) return
    root
      .querySelector('[data-slot="image-viewer-thumbnails"] [aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
  })
  createEffect(
    on(
      () => props.initialIndex,
      (value) => setIndex(clampImageIndex(value, props.images.length)),
    ),
  )
  createEffect(() => {
    if (active()) return
    resetInput()
    setMenuOpen(false)
    setContextOpen(false)
    action?.abort()
    setBusy(false)
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {})
  })
  createEffect(() => {
    if (!active()) return
    const preloads = [props.images[index() - 1], props.images[index() + 1]]
      .filter((image) => image && image.src !== current()?.src)
      .map((image) => {
        const preload = new Image()
        preload.src = image!.src
        return preload
      })
    onCleanup(() => {
      for (const image of preloads) image.removeAttribute("src")
    })
  })
  onMount(() => {
    setPortal(root)
    const resize = () => {
      if (stage.clientWidth > 0 && stage.clientHeight > 0)
        setView((state) => resizeImageViewer(state, { width: stage.clientWidth, height: stage.clientHeight }))
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    const changed = () => setFullscreen(document.fullscreenElement === root)
    document.addEventListener("fullscreenchange", changed)
    const wheel = (event: WheelEvent) => {
      if (!ready() || !active() || menuOpen() || contextOpen()) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1
      setView((state) =>
        applyImageViewerWheel(
          state,
          { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
          point(event),
        ),
      )
    }
    stage.addEventListener("wheel", wheel, { passive: false })
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("fullscreenchange", changed)
      stage.removeEventListener("wheel", wheel)
    })
  })
  onCleanup(() => {
    action?.abort()
    resetInput()
  })
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = stage.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.x) * stage.clientWidth) / rect.width,
      y: ((event.clientY - rect.y) * stage.clientHeight) / rect.height,
    }
  }
  async function perform(name: keyof ImageViewerActions | "source") {
    const image = current(),
      run = name === "source" ? props.onOpenSource : props.actions?.[name]
    if (!image || !run || busy()) return
    const request = new AbortController()
    action?.abort()
    action = request
    setBusy(true)
    setNotice({ text: _(copy.busy) })
    try {
      const result = await run({ ...image }, request.signal)
      if (request.signal.aborted) return
      if (name === "source") {
        setNotice(undefined)
        return
      }
      const message =
        result === "cancelled"
          ? copy.cancelled
          : name === "copy"
            ? copy.copied
            : name === "copyLink"
              ? copy.linkCopied
              : name === "save"
                ? result === "dispatched"
                  ? copy.downloaded
                  : copy.saved
                : copy.opened
      setNotice({ text: _(message) })
    } catch (error) {
      if (!request.signal.aborted)
        setNotice({ text: error instanceof Error ? error.message : _(copy.actionFailed), error: true })
    } finally {
      if (action === request) {
        action = undefined
        setBusy(false)
      }
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen()
      else await root.requestFullscreen()
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : _(copy.actionFailed), error: true })
    }
  }
  const commands: ImageViewerCommand[] = [
    {
      id: "fit",
      label: () => _(copy.fit),
      icon: "action.expand",
      text: () => _(copy.fitLabel),
      toolbar: true,
      pressed: () => view().mode === "fit",
      disabled: () => !ready(),
      run: () => setMode("fit"),
    },
    {
      id: "actual",
      label: () => _(copy.actual),
      icon: "image.actual",
      text: () => "1:1",
      toolbar: true,
      pressed: () => view().mode === "free" && view().scale === 1,
      disabled: () => !ready(),
      run: () => setMode("actual"),
    },
    {
      id: "zoomOut",
      label: () => _(copy.zoomOut),
      icon: "action.zoomOut",
      toolbar: true,
      disabled: () => !ready() || view().scale <= bounds().min,
      run: () => setView((value) => stepImageViewerZoom(value, "out")),
    },
    {
      id: "zoomIn",
      label: () => _(copy.zoomIn),
      icon: "action.zoomIn",
      toolbar: true,
      disabled: () => !ready() || view().scale >= bounds().max,
      run: () => setView((value) => stepImageViewerZoom(value, "in")),
    },
    {
      id: "rotate",
      label: () => _(copy.rotate),
      icon: "image.rotate",
      toolbar: true,
      disabled: () => !ready(),
      run: () => setView((value) => rotateImageViewer(value)),
    },
    {
      id: "copy",
      label: () => _(copy.copy),
      icon: "action.copy",
      toolbar: true,
      visible: () => !!props.actions?.copy,
      disabled: () => !ready() || busy(),
      run: () => void perform("copy"),
    },
    {
      id: "save",
      label: () => _(copy.save),
      icon: "action.download",
      toolbar: true,
      visible: () => !!props.actions?.save,
      disabled: () => !current() || busy(),
      run: () => void perform("save"),
    },
    {
      id: "fullscreen",
      label: () => _(fullscreen() ? copy.exitFullscreen : copy.fullscreen),
      icon: "workspace.fullscreen",
      toolbar: true,
      visible: () => !!document.fullscreenEnabled,
      run: () => void toggleFullscreen(),
    },
    {
      id: "background",
      label: () => _(copy.background),
      icon: "image.background",
      pressed: grid,
      run: () => setGrid((value) => !value),
    },
    {
      id: "thumbnails",
      label: () => _(copy.thumbnails),
      icon: "image.thumbnails",
      visible: () => props.images.length > 1,
      pressed: thumbnails,
      run: () => setThumbnails((value) => !value),
    },
    {
      id: "copyLink",
      label: () => _(copy.copyLink),
      icon: "action.copy",
      visible: () => !!props.actions?.copyLink && /^https?:/i.test(current()?.externalUrl ?? current()?.src ?? ""),
      disabled: busy,
      run: () => void perform("copyLink"),
    },
    {
      id: "openExternal",
      label: () => _(copy.openExternal),
      icon: "action.external",
      visible: () => !!props.actions?.openExternal && /^https?:/i.test(current()?.externalUrl ?? current()?.src ?? ""),
      disabled: busy,
      run: () => void perform("openExternal"),
    },
    {
      id: "source",
      label: () => _(copy.source),
      icon: "workspace.files",
      visible: () => !!props.onOpenSource && !!current()?.sourcePath,
      disabled: busy,
      run: () => void perform("source"),
    },
  ]
  function keyboard(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      !active() ||
      menuOpen() ||
      contextOpen() ||
      (event.target as HTMLElement).closest(
        'input, textarea, [contenteditable="true"], [role="menu"], [data-slot="image-viewer-thumbnails"]',
      )
    )
      return
    if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== "+")) return
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault()
      navigate(event.key === "PageDown" ? 1 : -1)
      return
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault()
      void toggleFullscreen()
      return
    }
    if (!ready() || !resolveImageViewerKey(event)) return
    event.preventDefault()
    setView((state) => applyImageViewerKey(state, event))
  }
  function navigate(delta: number) {
    setIndex((value) => clampImageIndex(value + delta, props.images.length))
    stage.focus({ preventScroll: true })
  }
  function pointerDown(event: PointerEvent) {
    if (!ready() || event.button !== 0 || !active()) return
    stage.focus({ preventScroll: true })
    pointers.set(event.pointerId, point(event))
    stage.setPointerCapture(event.pointerId)
    setDragging(canPan() || pointers.size > 1)
  }
  function pointerMove(event: PointerEvent) {
    const previous = pointers.get(event.pointerId)
    if (!previous) return
    const before = [...pointers.values()]
    const next = point(event)
    pointers.set(event.pointerId, next)
    const after = [...pointers.values()]
    if (before.length >= 2) {
      const center = (values: ImageViewerOffset[]) => ({
        x: (values[0]!.x + values[1]!.x) / 2,
        y: (values[0]!.y + values[1]!.y) / 2,
      })
      const distance = (values: ImageViewerOffset[]) =>
        Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y)
      const a = center(before),
        b = center(after),
        length = distance(before)
      setView((state) =>
        panImageViewer(zoomImageViewerAt(state, length ? distance(after) / length : 1, a), {
          x: b.x - a.x,
          y: b.y - a.y,
        }),
      )
    } else setView((state) => panImageViewer(state, { x: next.x - previous.x, y: next.y - previous.y }))
  }
  function pointerEnd(event: PointerEvent) {
    pointers.delete(event.pointerId)
    setDragging(pointers.size > 0 && canPan())
  }
  return (
    <div ref={root} data-component="image-viewer" onKeyDown={keyboard}>
      <OverlayLayerProvider layer={portal}>
        <ImageViewerControls
          commands={commands}
          menuLabel={_(copy.menu)}
          zoom={`${imageViewerZoomPercent(view())}%`}
          portal={portal()}
          active={active()}
          menuOpen={menuOpen()}
          onMenuOpen={setMenuOpen}
          contextOpen={contextOpen()}
          onContextOpen={setContextOpen}
        >
          <div
            ref={stage}
            data-slot="image-viewer-stage"
            data-grid={grid() || undefined}
            data-draggable={(ready() && canPan()) || undefined}
            data-dragging={dragging() || undefined}
            tabIndex={0}
            role="region"
            aria-label={current()?.filename ?? _(copy.empty)}
            aria-busy={!!current() && status() === "loading"}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onLostPointerCapture={pointerEnd}
            onDblClick={(event) => {
              if (ready())
                setView((state) =>
                  state.scale === 1 ? fitImageViewer(state) : zoomImageViewerAt(state, 1 / state.scale, point(event)),
                )
            }}
          >
            <Show keyed when={`${key()}\u0000${attempt()}`}>
              {(token) => {
                const image = current(),
                  identity = token
                const valid = () => identity === `${key()}\u0000${attempt()}`
                let element: HTMLImageElement | undefined
                const loaded = (image: HTMLImageElement) => {
                  if (!valid()) return
                  setView((state) =>
                    setImageViewerImage(state, { width: image.naturalWidth, height: image.naturalHeight }),
                  )
                  setStatus("ready")
                }
                onMount(() => {
                  if (element?.complete && element.naturalWidth > 0) loaded(element)
                })
                return (
                  <Show when={image} fallback={<div data-slot="image-viewer-state">{_(copy.empty)}</div>}>
                    <img
                      ref={element}
                      data-slot="image-viewer-image"
                      src={image?.src}
                      alt={image?.alt ?? image?.filename}
                      draggable={false}
                      style={{
                        width: `${view().image?.width ?? 0}px`,
                        height: `${view().image?.height ?? 0}px`,
                        visibility: ready() ? "visible" : "hidden",
                        transform: `translate(-50%, -50%) translate(${view().offset.x}px, ${view().offset.y}px) rotate(${view().rotation}deg) scale(${view().scale})`,
                      }}
                      onLoad={(event) => loaded(event.currentTarget)}
                      onError={() => {
                        if (valid()) setStatus("error")
                      }}
                    />
                  </Show>
                )
              }}
            </Show>
            <Show when={current() && status() === "loading"}>
              <div data-slot="image-viewer-state" role="status">
                <Spinner />
                <span>{_(copy.loading)}</span>
              </div>
            </Show>
            <Show when={status() === "error"}>
              <div data-slot="image-viewer-state" role="alert">
                <span>{_(copy.failed)}</span>
                <button
                  type="button"
                  data-component="button"
                  data-variant="secondary"
                  onClick={() => {
                    setStatus("loading")
                    setAttempt((value) => value + 1)
                  }}
                >
                  {_(copy.retry)}
                </button>
              </div>
            </Show>
          </div>
          <Show when={props.images.length > 1}>
            <button
              type="button"
              data-slot="image-viewer-nav"
              data-side="previous"
              aria-label={_(copy.previous)}
              disabled={index() === 0}
              onClick={() => navigate(-1)}
            >
              <Icon name={getSemanticIcon("navigation.back")} size="small" />
            </button>
            <button
              type="button"
              data-slot="image-viewer-nav"
              data-side="next"
              aria-label={_(copy.next)}
              disabled={index() >= props.images.length - 1}
              onClick={() => navigate(1)}
            >
              <Icon name={getSemanticIcon("navigation.forward")} size="small" />
            </button>
          </Show>
        </ImageViewerControls>
        <Show when={props.images.length > 1 && thumbnails()}>
          <div data-slot="image-viewer-thumbnails" role="group" aria-label={_(copy.thumbnails)}>
            <For each={props.images}>
              {(image, position) => (
                <button
                  type="button"
                  aria-label={image.filename}
                  aria-current={position() === index() ? "true" : undefined}
                  onClick={() => setIndex(position())}
                >
                  <img src={image.src} alt="" loading="lazy" draggable={false} />
                </button>
              )}
            </For>
          </div>
        </Show>
        <div data-slot="image-viewer-footer">
          <span title={metadata()}>{metadata()}</span>
          <span role="status" aria-live="polite" data-error={notice()?.error || undefined}>
            {notice()?.text}
          </span>
        </div>
      </OverlayLayerProvider>
    </div>
  )
}
