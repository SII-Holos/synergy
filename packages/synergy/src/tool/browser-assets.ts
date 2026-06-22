import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserAssets } from "../browser/assets"

export const BrowserAssetsTool = Tool.define("browser_assets", {
  description:
    "List assets loaded by a browser tab (images, scripts, stylesheets, fonts, media, documents, other). Returns assets classified by MIME type with URL, status, and size. Use this to inspect page resources and download candidates.",
  parameters: z.object({
    action: z.enum(["list"]).describe("Action to perform. Currently only 'list' is supported."),
    types: z
      .array(z.enum(["image", "script", "stylesheet", "font", "media", "document", "other"]))
      .describe("Filter by asset type. Returns all types if omitted.")
      .optional(),
    tabId: z.string().describe("Browser tab ID. Uses the active tab if omitted.").optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    const requests = await tab.networkRequests()
    let assets = BrowserAssets.fromNetworkBuffer(requests, tab.id)

    if (params.types && params.types.length > 0) {
      assets = BrowserAssets.filterByType(assets, params.types)
    }

    if (assets.length === 0) {
      return {
        title: `Page assets (0, tab: ${tab.id})`,
        output: "No page assets found.",
        metadata: { assetCount: 0, assets: [] as BrowserAssets.PageAsset[] },
      }
    }

    const lines = assets.map((a) => {
      const status = a.status != null ? String(a.status).padStart(3) : "---"
      const type = a.type.padEnd(12)
      const size = a.size != null ? `${a.size}B` : "---"
      return `${status} ${type} ${size} ${a.url}`
    })

    return {
      title: `Page assets (${assets.length}, tab: ${tab.id})`,
      output: lines.join("\n"),
      metadata: { assetCount: assets.length, assets },
    }
  },
})
