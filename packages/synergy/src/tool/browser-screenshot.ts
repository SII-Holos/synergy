import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"
import { Asset } from "../asset/asset"
import { Identifier } from "../id/id"

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description:
    "Capture a screenshot of the current browser page. Saves the image as an attachment delivered to the user. Returns the page dimensions and a preview description.",
  parameters: z.object({
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
    format: z.enum(["jpeg", "png"]).default("png").describe("Image format. Default png."),
    fullPage: z.boolean().default(false).describe("Capture the full scrollable page. Default false (viewport only)."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)
    const helperCtx: BrowserToolHelper.Context = {
      scopeID: owner.scopeID,
      directory: owner.directory,
      sessionID: owner.sessionID,
    }
    const tab = await BrowserToolHelper.getTab(helperCtx, params.tabId)

    const { buffer, width, height } = await tab.screenshot(params.format, undefined, params.fullPage)
    const mime = params.format === "jpeg" ? "image/jpeg" : "image/png"
    const assetId = await Asset.write(buffer, mime)

    const filename = `screenshot-${tab.id.slice(0, 8)}-${Date.now()}.${params.format}`

    return {
      title: `Screenshot of ${tab.url || tab.title || "page"}`,
      output: `Screenshot captured: ${width}x${height} ${params.format.toUpperCase()}${params.fullPage ? " (full page)" : ""}`,
      metadata: {
        url: tab.url,
        tabId: tab.id,
        width,
        height,
        format: params.format,
        fullPage: params.fullPage,
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
