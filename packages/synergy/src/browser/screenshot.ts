export namespace BrowserScreenshot {
  export interface ScreenshotResult {
    buffer: Buffer
    width: number
    height: number
    format: "png" | "jpeg"
  }

  /** Encode a screenshot buffer as a base64 data URL. */
  export function toDataURL(result: ScreenshotResult): string {
    const mime = result.format === "jpeg" ? "image/jpeg" : "image/png"
    return `data:${mime};base64,${result.buffer.toString("base64")}`
  }

  /** Translate display coordinates to page coordinates. */
  export function displayToPage(
    displayX: number,
    displayY: number,
    displayWidth: number,
    displayHeight: number,
    pageWidth: number,
    pageHeight: number,
  ): { x: number; y: number } {
    return {
      x: (displayX / displayWidth) * pageWidth,
      y: (displayY / displayHeight) * pageHeight,
    }
  }
}
