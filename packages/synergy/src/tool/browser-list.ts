import z from "zod"
import { Tool } from "./tool"
import { BrowserHost } from "../browser/host"

export const BrowserListTool = Tool.define("browser_list", {
  description: "List all browser sessions across the current scope. Shows whether each session has a browser page.",
  parameters: z.object({}),
  async execute() {
    const entries: { key: string; page: { id: string; url: string; title: string } | null; running: boolean }[] = []
    for (const [key, session] of BrowserHost.sessions()) {
      entries.push({
        key,
        page: session.page ? { id: session.page.id, url: session.page.url, title: session.page.title } : null,
        running: true,
      })
    }
    const lines =
      entries.length > 0
        ? entries.map((entry) => `${entry.key}: ${entry.page ? entry.page.url || "about:blank" : "no page"}`)
        : ["No active browser sessions"]
    return {
      title: `Browser sessions (${entries.length})`,
      output: lines.join("\n"),
      metadata: { count: entries.length },
    }
  },
})
