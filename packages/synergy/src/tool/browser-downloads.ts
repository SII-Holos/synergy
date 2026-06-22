import z from "zod"
import { Tool } from "./tool"
import { BrowserDownloads } from "../browser/downloads"

interface BrowserDownloadsMetadata {
  records?: BrowserDownloads.DownloadRecord[]
  removed?: string
}

const parameters = z.object({
  action: z.enum(["list", "remove"]).describe("Action: list all download records or remove one by id"),
  id: z.string().optional().describe("Download record ID to remove (required for remove action)"),
})

export const BrowserDownloadsTool = Tool.define<typeof parameters, BrowserDownloadsMetadata>("browser_downloads", {
  description: "Manage browser download records: list all downloads or remove a download by its ID.",
  parameters,
  async execute(params, _ctx) {
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
      default:
        throw new Error(`Unknown action: ${(params as { action: string }).action}`)
    }
  },
})
