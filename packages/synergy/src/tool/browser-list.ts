import z from "zod"
import { Tool } from "./tool"
import { BrowserHost } from "../browser/host"

export const BrowserListTool = Tool.define("browser_list", {
  description:
    "List all browser sessions across the current scope. Shows whether each session has a browser page and its connection health.",
  parameters: z.object({}),
  async execute() {
    const entries: { key: string; page: { id: string; url: string; title: string } | null; healthy: boolean }[] = []
    for (const [key, session] of BrowserHost.sessions()) {
      const page = session.page
      const pageHealthy = page != null
      entries.push({
        key,
        page: page ? { id: page.id, url: page.url, title: page.title } : null,
        healthy: pageHealthy,
      })
    }
    const lines =
      entries.length > 0
        ? entries.map((entry) => {
            const status = entry.page ? (entry.healthy ? "✔" : "⚠") : "✖"
            return `${status} ${entry.key}: ${entry.page ? entry.page.url || "about:blank" : "no page"}`
          })
        : ["No active browser sessions"]
    return {
      title: `Browser sessions (${entries.length})`,
      output: lines.join("\n"),
      metadata: { count: entries.length, entries },
    }
  },
})
