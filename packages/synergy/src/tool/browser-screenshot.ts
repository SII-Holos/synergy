import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
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
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
    format: z.enum(["jpeg", "png"]).default("png").describe("Image format. Default png."),
    fullPage: z.boolean().default(false).describe("Capture the full scrollable page. Default false (viewport only)."),
    locator: z
      .object({ kind: z.string(), value: z.string() })
      .optional()
      .describe("Element locator for Playwright-powered element screenshot."),
    clip: ClipSchema.optional().describe("Screenshot region clip {x, y, width, height}. Overrides locator."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.getPage(owner, params.pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_screenshot",
      "Capturing screenshot",
      async () => {
        let clip: { x: number; y: number; width: number; height: number } | undefined
        let captureKind: "viewport" | "fullPage" | "locator" | "clip" = "viewport"
        const format = params.format as "png" | "jpeg"

        // ── Playwright path (preferred) ──────────────────────────────
        if (tab.page) {
          if (params.clip) {
            captureKind = "clip"
            clip = params.clip
            const buf = (await tab.page.screenshot({ type: format, clip })) as Buffer
            const { width, height } = clip
            return finishResult(tab, params, ctx, buf, width, height, captureKind)
          }

          if (params.locator) {
            captureKind = "locator"
            const result = await BrowserScreenshot.captureLocator(
              tab.page,
              params.locator as BrowserLocator.LocatorInput,
              {
                format,
                fullPage: params.fullPage,
              },
            )
            return finishResult(tab, params, ctx, result.buffer, result.width, result.height, captureKind)
          }

          // viewport or fullPage via Playwright
          captureKind = params.fullPage ? "fullPage" : "viewport"
          const buf = (await tab.page.screenshot({ type: format, fullPage: params.fullPage })) as Buffer
          const vp = tab.page.viewportSize()
          return finishResult(tab, params, ctx, buf, vp?.width ?? 0, vp?.height ?? 0, captureKind)
        }

        // ── Legacy fallback (tab.screenshot) ──────────────────────────
        if (params.clip) {
          clip = params.clip
          captureKind = "clip"
        } else if (params.locator) {
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

        const take = tab.screenshot.bind(tab)
        const { buffer, width, height } = await take(format, undefined, params.fullPage, clip)
        return finishResult(tab, params, ctx, buffer, width, height, captureKind)
      },
    )
  },
})

// ── Shared result builder ────────────────────────────────────────────
async function finishResult(
  tab: { id: string; url: string; title: string },
  params: { format: "png" | "jpeg"; fullPage: boolean },
  ctx: { sessionID: string; messageID: string },
  buffer: Buffer,
  width: number,
  height: number,
  captureKind: string,
) {
  const mime = params.format === "jpeg" ? "image/jpeg" : "image/png"
  const assetId = await Asset.write(buffer, mime)

  const filename = `screenshot-${tab.id.slice(0, 8)}-${Date.now()}.${params.format}`

  const outputParts: string[] = [`Screenshot captured: ${width}x${height} ${params.format.toUpperCase()}`]
  if (captureKind === "fullPage") outputParts.push("(full page)")
  if (captureKind === "locator") outputParts.push("(locator)")
  if (captureKind === "clip") outputParts.push("(clip)")
  outputParts.push(`Delivered as conversation attachment ${filename}; no local filesystem path was created.`)

  return {
    title: `Screenshot of ${tab.url || tab.title || "page"}`,
    output: outputParts.join(" "),
    metadata: {
      url: tab.url,
      pageId: tab.id,
      width,
      height,
      format: params.format,
      fullPage: params.fullPage,
      captureKind,
      assetId,
      filename,
    },
    attachments: [
      {
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime,
        filename,
        url: `asset://${assetId}`,
      },
    ],
  }
}
