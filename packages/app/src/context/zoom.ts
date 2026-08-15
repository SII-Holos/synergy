import { createEffect, createSignal, onCleanup } from "solid-js"

const STORAGE_KEY = "synergy.ui.zoom"
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.0
const ZOOM_STEP = 0.1
const WHEEL_THROTTLE_MS = 50

/** Round to the nearest 0.1 (ZOOM_STEP) to avoid float drift. */
function roundStep(value: number): number {
  return Math.round(value / ZOOM_STEP) * ZOOM_STEP
}

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, roundStep(value)))
}

function readStoredZoom(): number {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  if (!stored) return 1
  const parsed = Number.parseFloat(stored)
  if (!Number.isFinite(parsed)) return 1
  return clamp(parsed)
}

/** The global zoom factor in use (1 = 100%). */
export const [zoom, setZoom] = createSignal(readStoredZoom())

export function zoomIn(): void {
  setZoom(clamp(zoom() + ZOOM_STEP))
}

export function zoomOut(): void {
  setZoom(clamp(zoom() - ZOOM_STEP))
}

export function zoomReset(): void {
  setZoom(1)
}

function applyZoom(value: number): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.style.zoom = String(value)

  // CSS zoom changes the visual size of the root, but viewport units and the
  // browser's innerWidth/innerHeight remain in unscaled pixels. Keep the
  // layout box in the inverse coordinate space so its visual size still fits
  // the window at every zoom level.
  root.style.width = `calc(100vw / ${value})`
  root.style.height = `calc(100vh / ${value})`
}

// Apply on signal change + persist.
createEffect(() => {
  applyZoom(zoom())
  try {
    localStorage.setItem(STORAGE_KEY, String(zoom()))
  } catch {
    // storage may be unavailable (private mode); ignore
  }
})

function handleWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  if (event.deltaY === 0) return
  const direction = event.deltaY < 0 ? 1 : -1
  setZoom(clamp(zoom() + direction * ZOOM_STEP))
}

let lastWheelAt = 0
function handleWheelThrottled(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const now = Date.now()
  if (now - lastWheelAt < WHEEL_THROTTLE_MS) return
  lastWheelAt = now
  handleWheel(event)
}

/**
 * Mounts global zoom listeners. Call once from the app root.
 * Captures wheel before the browser's native ctrl+wheel page zoom.
 */
export function ZoomController(): null {
  createEffect(() => {
    const onWheel = (event: WheelEvent) => handleWheelThrottled(event)

    // capture phase so we win over any app-level wheel handlers
    window.addEventListener("wheel", onWheel, { capture: true, passive: false })
    onCleanup(() => {
      window.removeEventListener("wheel", onWheel, { capture: true })
    })
  })

  return null
}
