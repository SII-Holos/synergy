import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"
import { BrowserAssets } from "../browser/assets"
import { BrowserExport } from "../browser/export"
import { ScopeContext } from "../scope/context"
import { sanitizeBrowserFilename } from "@ericsanchezok/synergy-browser"

const assetType = z.enum(["image", "script", "stylesheet", "font", "media", "document", "other"])

export const BrowserAssetsTool = Tool.define("browser_assets", {
  description:
    "List a bounded set of page assets or export a real manifest bundle into an authorized workspace directory.",
  parameters: z
    .object({
      action: z.enum(["list", "export"]),
      types: z.array(assetType).max(7).optional(),
      outputDir: z.string().min(1).max(20_000).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "export" && !value.outputDir) {
        ctx.addIssue({ code: "custom", path: ["outputDir"], message: "outputDir is required for export." })
      }
      if (value.action === "list" && value.outputDir !== undefined) {
        ctx.addIssue({ code: "custom", path: ["outputDir"], message: "outputDir is valid only for export." })
      }
    }),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const network = await BrowserToolHelper.execute(
      ctx,
      { type: "network", action: "list", page: 0, pageSize: params.limit },
      "assets-list",
    )
    if (network.type !== "data") throw new Error("Browser assets could not read network records.")
    const records = (network.data as { requests?: Array<Record<string, unknown>> }).requests ?? []
    let assets: BrowserAssets.PageAsset[] = records.map((record) => ({
      id: String(record.id ?? ""),
      pageID: page.id,
      url: String(record.url ?? ""),
      type: BrowserAssets.classifyByMime(
        String((record.responseHeaders as Record<string, string> | undefined)?.["content-type"] ?? ""),
      ),
      status: typeof record.status === "number" ? record.status : undefined,
      mimeType:
        String((record.responseHeaders as Record<string, string> | undefined)?.["content-type"] ?? "") || undefined,
      initiator: typeof record.resourceType === "string" ? record.resourceType : undefined,
    }))
    if (params.types?.length) assets = BrowserAssets.filterByType(assets, params.types)

    let exported: string | undefined
    if (params.action === "export") {
      if (!params.outputDir) throw new Error("outputDir is required for asset export.")
      const outputDir = await BrowserExport.createDirectory(ScopeContext.current.directory, params.outputDir)
      const manifest: Array<BrowserAssets.PageAsset & { file?: string; error?: string }> = []
      let totalSize = 0
      try {
        for (const [index, asset] of assets.entries()) {
          const detail = await BrowserToolHelper.execute(
            ctx,
            {
              type: "network",
              action: "get",
              id: asset.id,
              includeBody: true,
              includeSensitive: true,
              maxBodyBytes: 10 * 1024 * 1024,
            },
            `assets-get-${index}`,
          )
          const data = detail.type === "data" ? (detail.data as Record<string, unknown> | null) : null
          if (!data || typeof data.body !== "string") {
            manifest.push({ ...asset, error: "Response body is no longer available." })
            continue
          }
          if (data.bodyTruncated) {
            manifest.push({ ...asset, error: "Response body exceeded the 10 MB per-asset limit." })
            continue
          }
          const content = data.base64Encoded ? Buffer.from(data.body, "base64") : Buffer.from(data.body, "utf8")
          totalSize += content.byteLength
          if (totalSize > 50 * 1024 * 1024) throw new Error("Asset bundle exceeds the 50 MB total limit.")
          const fileName = assetFileName(asset.url, index)
          await fs.writeFile(path.join(outputDir, fileName), content, { flag: "wx", mode: 0o600 })
          manifest.push({ ...asset, size: content.byteLength, file: fileName })
        }
        exported = path.join(outputDir, "manifest.json")
        await fs.writeFile(exported, JSON.stringify({ assets: manifest, totalSize }, null, 2), {
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        await fs.rm(outputDir, { recursive: true, force: true })
        throw error
      }
    }
    const formatted = formatBrowserJSON(assets)
    return {
      title: `Browser assets (${assets.length})`,
      output: `${formatted.output}${exported ? `\nExported: ${exported}` : ""}`,
      metadata: {
        pageId: page.id,
        assetCount: assets.length,
        assets,
        exported,
        outputTruncated: formatted.truncated,
      },
    }
  },
})

function assetFileName(url: string, index: number): string {
  let basename = "asset"
  try {
    basename = path.basename(new URL(url).pathname) || "asset"
  } catch {}
  const safe = sanitizeBrowserFilename(basename, "asset").replace(/[^a-zA-Z0-9._-]/g, "_")
  return `${String(index + 1).padStart(3, "0")}-${safe || "asset"}`
}
