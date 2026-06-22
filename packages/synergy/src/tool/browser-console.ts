import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { Instance } from "../scope/instance"

export const BrowserConsoleTool = Tool.define("browser_console", {
  description:
    "Get console entries from a browser tab's console buffer. Returns entries formatted as plain text lines with timestamp, level, and message. Use this to inspect JavaScript runtime errors, warnings, and log output from the page.",
  parameters: z.object({
    tabId: z.string().describe("Browser tab ID. Uses the active tab if omitted.").optional(),
    maxEntries: z.number().describe("Maximum entries to return (default 50).").default(50).optional(),
    filter: z.string().describe("Optional regex pattern to filter entries by text content.").optional(),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const helperCtx: BrowserToolHelper.Context = {
      scopeID: Instance.scope.id,
      sessionID: ctx.sessionID,
    }
    const tab = BrowserToolHelper.getTab(helperCtx, params.tabId)

    const entries = await tab.consoleEntries(params.maxEntries ?? 50)

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
})
