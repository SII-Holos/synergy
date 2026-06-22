import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"
import { BrowserLocator } from "../browser/locator"
import { BrowserScreenshot } from "../browser/screenshot"
import { Asset } from "../asset/asset"
import { Identifier } from "../id/id"

const ClipSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
})

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description:
    "Capture a screenshot of the current browser page. Supports viewport, fullPage, locator-targeted, and region clip captures. Saves the image as an attachment delivered to the user. Returns page dimensions and a preview description.",
  parameters: z.object({
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
    format: z.enum(["jpeg", "png"]).default("png").describe("Image format. Default png."),
    fullPage: z.boolean().default(false).describe("Capture the full scrollable page. Default false (viewport only)."),
    locator: z
      .object({ kind: z.string(), value: z.string() })
      .optional()
      .describe("Locator for element-targeted screenshot. Resolves element bounds and captures that region."),
    clip: ClipSchema.optional().describe("Screenshot region clip {x, y, width, height}. Overrides locator."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.getTab(owner, params.tabId)

    let clip: { x: number; y: number; width: number; height: number } | undefined
    let captureKind: "viewport" | "fullPage" | "locator" | "clip" = "viewport"

    if (params.clip) {
      clip = params.clip
      captureKind = "clip"
    } else if (params.locator) {
      // Resolve the locator on the page to get element bounds
      const resolved = await BrowserLocator.resolve(tab, params.locator as BrowserLocator.LocatorInput)
      if (!resolved) {
        throw new Error(`Locator ${JSON.stringify(params.locator)} did not match any element.`)
      }
      clip = BrowserScreenshot.computeClipForLocator(
        { x: resolved.x, y: resolved.y, width: resolved.width, height: resolved.height },
        params.locator,
      )
      captureKind = "locator"
    } else if (params.fullPage) {
      captureKind = "fullPage"
    }

    const { buffer, width, height } = await tab.screenshot(params.format, undefined, params.fullPage, clip)
    const mime = params.format === "jpeg" ? "image/jpeg" : "image/png"
    const assetId = await Asset.write(buffer, mime)

    const filename = `screenshot-${tab.id.slice(0, 8)}-${Date.now()}.${params.format}`

    const outputParts: string[] = [`Screenshot captured: ${width}x${height} ${params.format.toUpperCase()}`]
    if (captureKind === "fullPage") outputParts.push("(full page)")
    if (captureKind === "locator") outputParts.push("(locator)")
    if (captureKind === "clip") outputParts.push("(clip)")

    return {
      title: `Screenshot of ${tab.url || tab.title || "page"}`,
      output: outputParts.join(" "),
      metadata: {
        url: tab.url,
        tabId: tab.id,
        width,
        height,
        format: params.format,
        fullPage: params.fullPage,
        captureKind,
        assetId,
      },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file",
          mime,
          filename,
          url: `asset://${assetId}`,
        },
      ],
    }
  },
})
