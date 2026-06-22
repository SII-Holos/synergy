export namespace BrowserViewport {
  export interface ViewportConfig {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
  }

  export interface ClipBounds {
    x: number
    y: number
    width: number
    height: number
  }

  export const MIN_WIDTH = 320
  export const MAX_WIDTH = 7680
  export const MIN_HEIGHT = 240
  export const MAX_HEIGHT = 4320
  export const MIN_DSF = 0.25
  export const MAX_DSF = 4.0
  export const DEFAULT: ViewportConfig = Object.freeze({
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  })

  // ── viewportSchema ─────────────────────────────────────────────────

  export function createViewportConfig(
    width?: number,
    height?: number,
    deviceScaleFactor?: number,
    mobile?: boolean,
  ): ViewportConfig {
    return Object.freeze({
      width: width ?? DEFAULT.width,
      height: height ?? DEFAULT.height,
      deviceScaleFactor: deviceScaleFactor ?? DEFAULT.deviceScaleFactor,
      mobile: mobile ?? DEFAULT.mobile,
    })
  }

  // ── Validation ─────────────────────────────────────────────────────

  export function validateViewportDimensions(width: number, height: number): { ok: boolean; message?: string } {
    if (typeof width !== "number" || Number.isNaN(width)) {
      return { ok: false, message: "width must be a number" }
    }
    if (!Number.isInteger(width)) {
      return { ok: false, message: "width must be an integer" }
    }
    if (width < MIN_WIDTH) {
      return { ok: false, message: `width must be at least ${MIN_WIDTH}` }
    }
    if (width > MAX_WIDTH) {
      return { ok: false, message: `width must be at most ${MAX_WIDTH}` }
    }
    if (typeof height !== "number" || Number.isNaN(height)) {
      return { ok: false, message: "height must be a number" }
    }
    if (!Number.isInteger(height)) {
      return { ok: false, message: "height must be an integer" }
    }
    if (height < MIN_HEIGHT) {
      return { ok: false, message: `height must be at least ${MIN_HEIGHT}` }
    }
    if (height > MAX_HEIGHT) {
      return { ok: false, message: `height must be at most ${MAX_HEIGHT}` }
    }
    return { ok: true }
  }

  export function validateDeviceScaleFactor(dsf: number): { ok: boolean; message?: string } {
    if (typeof dsf !== "number" || Number.isNaN(dsf)) {
      return { ok: false, message: "deviceScaleFactor must be a number" }
    }
    if (dsf <= 0) {
      return { ok: false, message: "deviceScaleFactor must be positive" }
    }
    if (dsf < MIN_DSF) {
      return {
        ok: false,
        message: `deviceScaleFactor must be at least ${MIN_DSF}`,
      }
    }
    if (dsf > MAX_DSF) {
      return {
        ok: false,
        message: `deviceScaleFactor must be at most ${MAX_DSF}`,
      }
    }
    return { ok: true }
  }

  export function validateViewport(config: Partial<ViewportConfig>): { ok: boolean; message?: string } {
    if (config.width !== undefined || config.height !== undefined) {
      const dims = validateViewportDimensions(config.width ?? DEFAULT.width, config.height ?? DEFAULT.height)
      if (!dims.ok) return dims
    }
    if (config.deviceScaleFactor !== undefined) {
      const dsf = validateDeviceScaleFactor(config.deviceScaleFactor)
      if (!dsf.ok) return dsf
    }
    return { ok: true }
  }

  // ── Screenshot geometry ────────────────────────────────────────────

  export function calculateClipBounds(
    elementBounds: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
  ): ClipBounds {
    const x = Math.max(0, elementBounds.x)
    const y = Math.max(0, elementBounds.y)
    const right = elementBounds.x + elementBounds.width
    const bottom = elementBounds.y + elementBounds.height

    const clipRight = Math.min(right, viewport.width)
    const clipBottom = Math.min(bottom, viewport.height)

    return {
      x,
      y,
      width: Math.max(0, clipRight - x),
      height: Math.max(0, clipBottom - y),
    }
  }

  export function calculateScreenshotResolution(
    viewport: { width: number; height: number },
    deviceScaleFactor: number = 1,
  ): { width: number; height: number } {
    return {
      width: Math.round(viewport.width * deviceScaleFactor),
      height: Math.round(viewport.height * deviceScaleFactor),
    }
  }

  // ── CDP command builders ───────────────────────────────────────────

  export function buildSetMetricsOverride(config: ViewportConfig): Record<string, unknown> {
    const screenWidth = config.mobile ? config.width : Math.max(config.width, 1280)
    const screenHeight = config.mobile ? config.height : Math.max(config.height, 720)
    return {
      width: config.width,
      height: config.height,
      deviceScaleFactor: config.deviceScaleFactor,
      mobile: config.mobile,
      screenWidth,
      screenHeight,
      positionX: 0,
      positionY: 0,
      fitWindow: false,
    }
  }

  export function buildClearMetricsOverride(): Record<string, unknown> {
    return {}
  }
}

export const {
  createViewportConfig,
  validateViewportDimensions,
  validateDeviceScaleFactor,
  validateViewport,
  calculateClipBounds,
  calculateScreenshotResolution,
} = BrowserViewport

export const { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT, MIN_DSF, MAX_DSF, DEFAULT } = BrowserViewport
