import z from "zod"
import { Tool } from "./tool"
import { BrowserHost } from "../browser/host"

export const BrowserListTool = Tool.define("browser_list", {
  description: "List all browser sessions across the current scope. Shows owner mode, tab count, and active tab info.",
  parameters: z.object({}),
  async execute() {
    const entries: { key: string; tabsCount: number; running: boolean }[] = []
    for (const [key, session] of BrowserHost.sessions()) {
      entries.push({ key, tabsCount: session.tabs.length, running: true })
    }
    const lines =
      entries.length > 0 ? entries.map((e) => `${e.key}: ${e.tabsCount} tabs`) : ["No active browser sessions"]
    return {
      title: `Browser sessions (${entries.length})`,
      output: lines.join("\n"),
      metadata: { count: entries.length },
    }
  },
})
