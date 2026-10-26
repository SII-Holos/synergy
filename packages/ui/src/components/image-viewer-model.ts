export interface ImageViewerSize {
  width: number
  height: number
}

export interface ImageViewerOffset {
  x: number
  y: number
}

export interface ImageViewerRect extends ImageViewerOffset, ImageViewerSize {}

export type ImageViewerMode = "fit" | "free"

export interface ImageViewerState {
  image?: ImageViewerSize
  viewport: ImageViewerSize
  rotation: number
  mode: ImageViewerMode
  scale: number
  offset: ImageViewerOffset
}

export type ImageViewerKeyCommand =
  | { kind: "pan"; delta: ImageViewerOffset }
  | { kind: "zoom"; direction: "in" | "out" }
  | { kind: "fit" }
  | { kind: "actual" }
  | { kind: "rotate" }

export type ImageViewerWheelCommand = { kind: "zoom"; factor: number } | { kind: "pan"; delta: ImageViewerOffset }

export const IMAGE_VIEWER_FIT_PADDING = 24
export const IMAGE_VIEWER_MAX_SCALE = 8
export const IMAGE_VIEWER_ZOOM_STEP = 1.25
export const IMAGE_VIEWER_KEY_PAN_STEP = 40

const WHEEL_ZOOM_RATE = 0.0025
const PINCH_ZOOM_RATE = 0.01
const WHEEL_ZOOM_LIMIT = 2

const ORIGIN: ImageViewerOffset = { x: 0, y: 0 }

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function sameOffset(left: ImageViewerOffset, right: ImageViewerOffset) {
  return left.x === right.x && left.y === right.y
}

function normalizedRotation(rotation: number) {
  if (!Number.isFinite(rotation)) return 0
  return (((Math.round(rotation / 90) * 90) % 360) + 360) % 360
}

function naturalSize(image: ImageViewerSize, rotation: number) {
  const turned = normalizedRotation(rotation) % 180 !== 0
  return turned ? { width: image.height, height: image.width } : { width: image.width, height: image.height }
}

function boundedOffset(
  state: ImageViewerState,
  scale: number,
  offset: ImageViewerOffset,
  rotation = state.rotation,
): ImageViewerOffset {
  if (!state.image) return { x: 0, y: 0 }
  const natural = naturalSize(state.image, rotation)
  const limitX = Math.max(0, (natural.width * scale - state.viewport.width) / 2)
  const limitY = Math.max(0, (natural.height * scale - state.viewport.height) / 2)
  return {
    x: clampNumber(offset.x, -limitX, limitX),
    y: clampNumber(offset.y, -limitY, limitY),
  }
}

export function imageViewerFitScale(input: {
  image?: ImageViewerSize
  viewport: ImageViewerSize
  rotation: number
  padding?: number
}) {
  const image = input.image
  if (!image || image.width <= 0 || image.height <= 0) return 1
  const padding = input.padding ?? IMAGE_VIEWER_FIT_PADDING
  if (input.viewport.width <= 0 || input.viewport.height <= 0) return 1
  const width = input.viewport.width - Math.min(padding, input.viewport.width / 4) * 2
  const height = input.viewport.height - Math.min(padding, input.viewport.height / 4) * 2
  const natural = naturalSize(image, input.rotation)
  return Math.min(1, width / natural.width, height / natural.height)
}

export function imageViewerScaleBounds(state: ImageViewerState) {
  return { min: imageViewerFitScale(state), max: IMAGE_VIEWER_MAX_SCALE }
}

export function createImageViewerState(input: {
  image?: ImageViewerSize
  viewport: ImageViewerSize
  mode: ImageViewerMode
}): ImageViewerState {
  const base = {
    image: input.image,
    viewport: input.viewport,
    rotation: 0,
    mode: input.mode,
    offset: { x: 0, y: 0 },
  }
  return { ...base, scale: input.mode === "fit" ? imageViewerFitScale(base) : 1 }
}

export function imageViewerDisplayRect(state: ImageViewerState): ImageViewerRect {
  if (!state.image) return { x: state.viewport.width / 2, y: state.viewport.height / 2, width: 0, height: 0 }
  const natural = naturalSize(state.image, state.rotation)
  const width = natural.width * state.scale
  const height = natural.height * state.scale
  return {
    x: (state.viewport.width - width) / 2 + state.offset.x,
    y: (state.viewport.height - height) / 2 + state.offset.y,
    width,
    height,
  }
}

export function imageViewerZoomPercent(state: ImageViewerState) {
  return Math.round(state.scale * 100)
}

export function imageViewerEntryKey(image: { id: string; src: string }) {
  return `${image.id}\u0000${image.src}`
}

export function setImageViewerImage(state: ImageViewerState, image: ImageViewerSize): ImageViewerState {
  const next: ImageViewerState = { ...state, image }
  if (state.mode === "fit") return { ...next, scale: imageViewerFitScale(next), offset: { x: 0, y: 0 } }
  const scale = Math.max(state.scale, imageViewerFitScale(next))
  return { ...next, scale, offset: boundedOffset(next, scale, state.offset) }
}

export function fitImageViewer(state: ImageViewerState): ImageViewerState {
  const scale = imageViewerFitScale(state)
  if (state.mode === "fit" && state.scale === scale && sameOffset(state.offset, ORIGIN)) return state
  return { ...state, mode: "fit", scale, offset: { x: 0, y: 0 } }
}

export function actualImageViewer(state: ImageViewerState): ImageViewerState {
  const offset = boundedOffset(state, 1, state.offset)
  if (state.mode === "free" && state.scale === 1 && sameOffset(state.offset, offset)) return state
  return { ...state, mode: "free", scale: 1, offset }
}

export function panImageViewer(state: ImageViewerState, delta: ImageViewerOffset): ImageViewerState {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return state
  const offset = boundedOffset(state, state.scale, {
    x: state.offset.x + delta.x,
    y: state.offset.y + delta.y,
  })
  if (sameOffset(state.offset, offset)) return state
  return { ...state, mode: "free", offset }
}

export function zoomImageViewerAt(
  state: ImageViewerState,
  factor: number,
  anchor?: ImageViewerOffset,
): ImageViewerState {
  if (!state.image || !Number.isFinite(factor) || factor <= 0) return state
  const bounds = imageViewerScaleBounds(state)
  if (state.scale * factor <= bounds.min) return fitImageViewer(state)
  const scale = Math.min(bounds.max, state.scale * factor)
  if (scale === state.scale) return state
  const point = anchor ?? { x: state.viewport.width / 2, y: state.viewport.height / 2 }
  const before = imageViewerDisplayRect(state)
  const source = {
    x: (point.x - before.x) / state.scale,
    y: (point.y - before.y) / state.scale,
  }
  const natural = state.image ? naturalSize(state.image, state.rotation) : { width: 0, height: 0 }
  const offset = boundedOffset(state, scale, {
    x: point.x - source.x * scale - (state.viewport.width - natural.width * scale) / 2,
    y: point.y - source.y * scale - (state.viewport.height - natural.height * scale) / 2,
  })
  return { ...state, mode: "free", scale, offset }
}

export function stepImageViewerZoom(state: ImageViewerState, direction: "in" | "out") {
  return zoomImageViewerAt(state, direction === "in" ? IMAGE_VIEWER_ZOOM_STEP : 1 / IMAGE_VIEWER_ZOOM_STEP)
}

export function rotateImageViewer(state: ImageViewerState, turns = 1): ImageViewerState {
  const rotation = normalizedRotation(state.rotation + turns * 90)
  if (rotation === state.rotation) return state
  const next: ImageViewerState = { ...state, rotation }
  if (state.mode === "fit") return { ...next, scale: imageViewerFitScale(next), offset: { x: 0, y: 0 } }
  const scale = Math.max(state.scale, imageViewerFitScale(next))
  return { ...next, scale, offset: boundedOffset(next, scale, state.offset) }
}

export function resizeImageViewer(state: ImageViewerState, viewport: ImageViewerSize): ImageViewerState {
  if (viewport.width === state.viewport.width && viewport.height === state.viewport.height) return state
  const next: ImageViewerState = { ...state, viewport }
  if (state.mode === "fit") return { ...next, scale: imageViewerFitScale(next), offset: { x: 0, y: 0 } }
  const scale = Math.max(state.scale, imageViewerFitScale(next))
  return { ...next, scale, offset: boundedOffset(next, scale, state.offset) }
}

export function resolveImageViewerKey(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): ImageViewerKeyCommand | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  switch (event.key) {
    case "ArrowLeft":
      return { kind: "pan", delta: { x: -IMAGE_VIEWER_KEY_PAN_STEP, y: 0 } }
    case "ArrowRight":
      return { kind: "pan", delta: { x: IMAGE_VIEWER_KEY_PAN_STEP, y: 0 } }
    case "ArrowUp":
      return { kind: "pan", delta: { x: 0, y: -IMAGE_VIEWER_KEY_PAN_STEP } }
    case "ArrowDown":
      return { kind: "pan", delta: { x: 0, y: IMAGE_VIEWER_KEY_PAN_STEP } }
    case "+":
    case "=":
      return { kind: "zoom", direction: "in" }
    case "-":
      return { kind: "zoom", direction: "out" }
    case "0":
      return { kind: "fit" }
    case "1":
      return { kind: "actual" }
    case "r":
    case "R":
      return { kind: "rotate" }
    default:
      return undefined
  }
}

export function applyImageViewerKey(
  state: ImageViewerState,
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
): ImageViewerState {
  const command = resolveImageViewerKey(event)
  if (!command) return state
  switch (command.kind) {
    case "pan":
      return panImageViewer(state, command.delta)
    case "zoom":
      return stepImageViewerZoom(state, command.direction)
    case "actual":
      return actualImageViewer(state)
    case "rotate":
      return rotateImageViewer(state)
    case "fit":
      return fitImageViewer(state)
  }
}

// Trackpad pinch always arrives as ctrl+wheel, which needs a faster rate than an
// ordinary wheel; horizontal-dominant scrolling pans instead of zooming.
export function resolveImageViewerWheel(event: {
  deltaX: number
  deltaY: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): ImageViewerWheelCommand | undefined {
  if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return undefined
  if (event.deltaX === 0 && event.deltaY === 0) return undefined
  const pinch = Boolean(event.ctrlKey || event.metaKey)
  if (!pinch && Math.abs(event.deltaX) > Math.abs(event.deltaY))
    return { kind: "pan", delta: { x: -event.deltaX, y: -event.deltaY } }
  const rate = pinch ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE
  const limit = WHEEL_ZOOM_LIMIT
  const factor = clampNumber(Math.exp(-event.deltaY * rate), 1 / limit, limit)
  return { kind: "zoom", factor }
}

export function applyImageViewerWheel(
  state: ImageViewerState,
  event: { deltaX: number; deltaY: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  anchor?: ImageViewerOffset,
): ImageViewerState {
  const command = resolveImageViewerWheel(event)
  if (!command) return state
  return command.kind === "zoom"
    ? zoomImageViewerAt(state, command.factor, anchor)
    : panImageViewer(state, command.delta)
}
