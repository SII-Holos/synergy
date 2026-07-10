import z from "zod"
import { BrowserClipSchema, BrowserLocatorSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { Asset } from "../asset/asset"
import { Identifier } from "../id/id"

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description:
    "Capture exactly one PNG screenshot type: viewport, full page, clip, or uniquely matched locator. A failed requested type never falls back to another capture.",
  parameters: z
    .object({
      fullPage: z.literal(true).optional(),
      clip: BrowserClipSchema.optional(),
      target: BrowserLocatorSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const modes = Number(Boolean(value.fullPage)) + Number(Boolean(value.clip)) + Number(Boolean(value.target))
      if (modes <= 1) return
      ctx.addIssue({ code: "custom", message: "Choose only one of fullPage, clip, or target." })
    }),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      "reading",
      "browser_screenshot",
      "Capturing screenshot",
      async () => {
        const result = await BrowserToolHelper.execute(ctx, {
          type: "screenshot",
          fullPage: params.fullPage,
          clip: params.clip,
          target: params.target,
        })
        if (result.type !== "screenshot") throw new Error("Browser screenshot returned an unexpected result.")
        const buffer = Buffer.from(result.dataUrl.split(",", 2)[1] ?? "", "base64")
        const filename = `browser-${page.id.slice(0, 8)}-${Date.now()}.png`
        const assetId = await Asset.write(buffer, "image/png", filename)
        const kind = params.target ? "locator" : params.clip ? "clip" : params.fullPage ? "fullPage" : "viewport"
        return {
          title: `Screenshot of ${page.url || page.title || "page"}`,
          output: `Captured ${kind} screenshot (${result.width}x${result.height}) as ${filename}.`,
          metadata: {
            pageId: page.id,
            url: page.url,
            width: result.width,
            height: result.height,
            captureKind: kind,
            assetId,
            filename,
          },
          attachments: [
            {
              id: Identifier.ascending("part"),
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: "attachment" as const,
              mime: "image/png",
              filename,
              url: `asset://${assetId}`,
              presentation: { renderer: "image" as const, size: "large" as const, crop: false },
              model: {
                mode: "summary" as const,
                summary: `${filename} browser screenshot ${result.width}x${result.height}`,
              },
            },
          ],
        }
      },
    )
  },
})
