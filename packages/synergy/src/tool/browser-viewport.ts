import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserViewport } from "../browser/viewport"

export const BrowserViewportTool = Tool.define("browser_viewport", {
  description:
    "Set or reset the browser viewport dimensions, device scale factor, and mobile mode. Use 'set' to configure custom viewport properties, 'reset' to clear overrides back to default, or 'status' to read the current page viewport dimensions.",
  parameters: z.object({
    width: z
      .number()
      .int()
      .min(BrowserViewport.MIN_WIDTH)
      .max(BrowserViewport.MAX_WIDTH)
      .optional()
      .describe("Viewport width in pixels (ignored for reset and status actions)"),
    height: z
      .number()
      .int()
      .min(BrowserViewport.MIN_HEIGHT)
      .max(BrowserViewport.MAX_HEIGHT)
      .optional()
      .describe("Viewport height in pixels (ignored for reset and status actions)"),
    deviceScaleFactor: z
      .number()
      .min(BrowserViewport.MIN_DSF)
      .max(BrowserViewport.MAX_DSF)
      .optional()
      .describe("Device scale factor, e.g. 2 for Retina (ignored for reset and status actions)"),
    mobile: z.boolean().optional().describe("Emulate a mobile device (ignored for reset and status actions)"),
    action: z
      .enum(["set", "reset", "status"])
      .default("set")
      .describe("set = apply override, reset = clear override, status = read current viewport"),
    tabId: z.string().optional().describe("Tab to operate on. Uses the active tab when omitted."),
  }),
  async execute(
    params,
    ctx,
  ): Promise<{
    title: string
    output: string
    metadata: Record<string, unknown>
  }> {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const cdp = tab.cdp
    if (!cdp) throw new Error("Browser CDP connection not available")

    if (params.action === "status") {
      const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
        cssLayoutViewport?: { clientWidth: number; clientHeight: number }
        visualViewport?: { pageScaleFactor?: number }
      }
      const w = metrics.cssLayoutViewport?.clientWidth ?? 0
      const h = metrics.cssLayoutViewport?.clientHeight ?? 0
      const dsf = metrics.visualViewport?.pageScaleFactor ?? 1
      return {
        title: "Viewport status",
        output: `Viewport: ${w}x${h} (deviceScaleFactor: ${dsf})`,
        metadata: { width: w, height: h, deviceScaleFactor: dsf, tabId: tab.id },
      }
    }

    if (params.action === "reset") {
      await cdp.send("Emulation.clearDeviceMetricsOverride")
      return {
        title: "Viewport reset",
        output: "Cleared device metrics override",
        metadata: { tabId: tab.id },
      }
    }

    // action === "set"
    const config = BrowserViewport.createViewportConfig(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
    )
    const validation = BrowserViewport.validateViewport({
      width: config.width,
      height: config.height,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    if (!validation.ok) {
      throw new Error(validation.message ?? "Invalid viewport configuration")
    }

    const cdpParams = BrowserViewport.buildSetMetricsOverride(config)
    await cdp.send("Emulation.setDeviceMetricsOverride", cdpParams)

    const size = `${config.width}x${config.height}`
    const dsfStr = config.deviceScaleFactor !== 1 ? ` @${config.deviceScaleFactor}x` : ""
    const mobileStr = config.mobile ? " (mobile)" : ""
    return {
      title: "Viewport set",
      output: `Viewport set to ${size}${dsfStr}${mobileStr}`,
      metadata: {
        width: config.width,
        height: config.height,
        deviceScaleFactor: config.deviceScaleFactor,
        mobile: config.mobile,
        tabId: tab.id,
      },
    }
  },
})
