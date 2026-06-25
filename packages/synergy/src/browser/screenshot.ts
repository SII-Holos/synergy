import type { Page } from "playwright"
import { BrowserLocator } from "./locator"
import { ToolTimeout } from "@/tool/timeout"

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

  /**
   * Capture a screenshot of an element identified by locator using Playwright's locator.screenshot().
   * Falls back to full-page or viewport capture if the locator doesn't match in time.
   */
  export async function captureLocator(
    page: Page,
    locator: BrowserLocator.LocatorInput,
    opts?: { format?: "png" | "jpeg"; fullPage?: boolean },
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const pwLocator = BrowserLocator.toPlaywrightLocator(page, locator)
    const format = opts?.format ?? "png"

    try {
      await pwLocator.waitFor({ state: "attached", timeout: ToolTimeout.DEFAULTS.browserLocatorMs })
      const buf = (await pwLocator.screenshot({ type: format })) as Buffer
      const box = await pwLocator.boundingBox()
      return {
        buffer: buf,
        width: Math.round(box?.width ?? 0),
        height: Math.round(box?.height ?? 0),
      }
    } catch {
      // Locator not found or timed out; fall back to page-level screenshot.
      const screenshotOpts: Parameters<Page["screenshot"]>[0] = { type: format }
      if (opts?.fullPage) screenshotOpts.fullPage = true
      const buf = (await page.screenshot(screenshotOpts)) as Buffer
      const vp = page.viewportSize()
      return {
        buffer: buf,
        width: vp?.width ?? 0,
        height: vp?.height ?? 0,
      }
    }
  }
}
