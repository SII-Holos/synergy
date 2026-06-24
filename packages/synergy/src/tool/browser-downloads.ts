import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserDownloads } from "../browser/downloads"

interface BrowserDownloadsMetadata {
  records?: BrowserDownloads.DownloadRecord[]
  removed?: string
  download?: BrowserDownloads.DownloadRecord
}

const parameters = z
  .object({
    action: z
      .enum(["list", "remove", "wait"])
      .describe("Action: list downloads, remove one by id, or wait for one to complete"),
    id: z.string().optional().describe("Download record ID (required for remove and wait actions)"),
    timeoutMs: z.number().int().positive().optional().describe("Maximum wait time in milliseconds (default 30s)"),
    tabId: z.string().optional().describe("Tab ID. Used to access page for waitForPageDownload."),
  })
  .refine(
    (v) => {
      if ((v.action === "remove" || v.action === "wait") && !v.id) return false
      return true
    },
    { message: "id is required for remove and wait actions" },
  )

export const BrowserDownloadsTool = Tool.define<typeof parameters, BrowserDownloadsMetadata>("browser_downloads", {
  description:
    "Manage browser download records: list downloads, wait for one to complete, or remove a download by its ID.",
  parameters,
  async execute(params, ctx) {
    let activityTab = null as Awaited<ReturnType<typeof BrowserToolHelper.resolveTab>> | null
    try {
      activityTab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
      await BrowserToolHelper.markActivity(
        ctx,
        activityTab,
        "reading",
        "browser_downloads",
        `Downloads ${params.action}`,
      )
    } catch {
      activityTab = null
    }
    try {
      switch (params.action) {
        case "list": {
          const records = BrowserDownloads.list()
          return {
            title: `Downloads (${records.length})`,
            output: JSON.stringify(records, null, 2),
            metadata: { records },
          }
        }
        case "remove": {
          if (!params.id) throw new Error("id is required for remove action")
          const removed = BrowserDownloads.remove(params.id)
          if (!removed) throw new Error(`Download record ${params.id} not found`)
          return {
            title: "Removed",
            output: `Removed download record ${params.id}`,
            metadata: { removed: params.id },
          }
        }
        case "wait": {
          // schema.refine already ensures id is present for wait action
          const id = params.id!
          const result = await BrowserDownloads.waitForDownload(id, params.timeoutMs)
          return {
            title: `Download ${result.id} (${result.state})`,
            output: JSON.stringify(result, null, 2),
            metadata: { download: result },
          }
        }
        default:
          throw new Error(`Unknown action: ${(params as { action: string }).action}`)
      }
    } finally {
      if (activityTab) await BrowserToolHelper.markIdle(ctx, activityTab, "browser_downloads")
    }
  },
})
