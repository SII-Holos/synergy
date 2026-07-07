import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserViewport } from "../browser/viewport"
import { BrowserOwner } from "../browser/owner"

export const BrowserViewportTool = Tool.define("browser_viewport", {
  description:
    "Set or reset the browser viewport dimensions, device scale factor, and mobile mode. Use 'set' to configure custom viewport properties, 'reset' to clear overrides back to default, or 'status' to read the current page viewport dimensions.",
  parameters: z.object({
    width: z.number().int().min(BrowserViewport.MIN_WIDTH).max(BrowserViewport.MAX_WIDTH).optional(),
    height: z.number().int().min(BrowserViewport.MIN_HEIGHT).max(BrowserViewport.MAX_HEIGHT).optional(),
    deviceScaleFactor: z.number().min(BrowserViewport.MIN_DSF).max(BrowserViewport.MAX_DSF).optional(),
    mobile: z.boolean().optional(),
    action: z.enum(["set", "reset", "status"]).default("set"),
    pageId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
    const kind = params.action === "status" ? "reading" : "acting"
    return BrowserToolHelper.withActivity(ctx, tab, kind, "browser_viewport", `Viewport ${params.action}`, async () => {
      if (params.action === "status") {
        const page = tab.page
        if (!page) throw new Error("Browser page is not available")
        const viewport = page.viewportSize?.() ?? null
        return {
          title: "Viewport status",
          output: viewport ? `Viewport: ${viewport.width}x${viewport.height}` : "Viewport status unavailable",
          metadata: { ...(viewport ?? {}), pageId: tab.id },
        }
      }

      if (params.action === "reset") {
        const config = BrowserViewport.DEFAULT
        await BrowserToolHelper.executeControl(owner, {
          type: "setViewport",
          pageId: tab.id,
          width: config.width,
          height: config.height,
          deviceScaleFactor: config.deviceScaleFactor,
        })
        return {
          title: "Viewport reset",
          output: `Viewport reset to ${config.width}x${config.height}`,
          metadata: { width: config.width, height: config.height, pageId: tab.id },
        }
      }

      const config = BrowserViewport.createViewportConfig(
        params.width,
        params.height,
        params.deviceScaleFactor,
        params.mobile,
      )
      const validation = BrowserViewport.validateViewport(config)
      if (!validation.ok) throw new Error(validation.message ?? "Invalid viewport configuration")

      await BrowserToolHelper.executeControl(owner, {
        type: "setViewport",
        pageId: tab.id,
        width: config.width,
        height: config.height,
        deviceScaleFactor: config.deviceScaleFactor,
      })
      // Wait briefly for the page to stabilize after viewport resize
      await tab.waitFor({ type: "load" }, 2000).catch(() => {})
      return {
        title: "Viewport set",
        output: `Viewport set to ${config.width}x${config.height}${config.mobile ? " (mobile)" : ""}`,
        metadata: { ...config, pageId: tab.id },
      }
    })
  },
})
