export namespace BrowserScreenshot {
  export interface ResolvedBounds {
    x: number
    y: number
    width: number
    height: number
  }

  export interface ScreenshotInput {
    locator?: { kind: string; value: string }
    clip?: { x: number; y: number; width: number; height: number }
    format?: "png" | "jpeg"
    fullPage?: boolean
  }

  export interface ScreenshotClip {
    x: number
    y: number
    width: number
    height: number
  }

  /**
   * Compute a CDP clip region from a locator's resolved element bounds.
   * Rounds to integers and clamps negative x/y to 0.
   */
  export function computeClipForLocator(
    bounds: ResolvedBounds,
    _locator: { kind: string; value: string },
  ): ScreenshotClip {
    return {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    }
  }

  /**
   * Build the final screenshot clip parameters.
   * - If `input.clip` is present, uses it directly.
   * - If `input.locator` is present with resolved bounds, computes clip from bounds.
   * - Clip takes precedence over locator when both are present.
   */
  export function buildScreenshotParams(input: ScreenshotInput, resolvedBounds?: ResolvedBounds): ScreenshotClip {
    if (input.clip) return { ...input.clip }
    if (input.locator && resolvedBounds) return computeClipForLocator(resolvedBounds, input.locator)
    return { x: 0, y: 0, width: 0, height: 0 }
  }
}
