import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

export const BrowserConsoleTool = Tool.define("browser_console", {
  description:
    "Get console entries from a browser page's console buffer. Returns entries formatted as plain text lines with timestamp, level, and message. Use this to inspect JavaScript runtime errors, warnings, and log output from the page.",
  parameters: z.object({
    pageId: z.string().describe("Browser page ID. Uses the session page if omitted.").optional(),
    maxEntries: z.number().describe("Maximum entries to return (default 50).").default(50).optional(),
    filter: z.string().describe("Optional regex pattern to filter entries by text content.").optional(),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_console",
      "Reading console entries",
      async () => {
        const result = await BrowserToolHelper.executeControl(owner, {
          type: "console",
          pageId: tab.id,
          maxEntries: params.maxEntries ?? 50,
        })
        if (result.type !== "console") throw new Error("Browser console command returned an unexpected result")
        const entries = result.entries

        let filtered = entries
        if (params.filter) {
          let filterRegex: RegExp
          try {
            filterRegex = new RegExp(params.filter, "i")
          } catch {
            throw new Error(`Invalid regex filter: ${params.filter}`)
          }
          filtered = entries.filter((e) => filterRegex.test(e.text))
        }

        if (filtered.length === 0) {
          return {
            title: `Console entries (0, tab: ${tab.id})`,
            output: "No console entries found.",
            metadata: { entryCount: 0 },
          }
        }

        const lines = filtered.map((entry) => {
          const ts = new Date(entry.timestamp).toISOString()
          const level = entry.type.toUpperCase().padEnd(5)
          let line = `[${ts}] ${level} ${entry.text}`
          if (entry.stackTrace) {
            line += `\n  stack: ${entry.stackTrace}`
          }
          return line
        })

        return {
          title: `Console entries (${filtered.length}, tab: ${tab.id})`,
          output: lines.join("\n"),
          metadata: { entryCount: filtered.length },
        }
      },
    )
  },
})
