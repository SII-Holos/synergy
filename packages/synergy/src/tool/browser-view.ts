import z from "zod"
import { Tool } from "./tool"

const parameters = z.object({
  action: z
    .enum(["show", "hide", "focus", "status"])
    .describe(
      "show: open browser workspace panel. hide: close browser workspace panel. focus: switch active tool to browser. status: query current workspace open state.",
    ),
})

interface BrowserViewMetadata {
  action: string
  workspaceOpen?: boolean
}

export const BrowserViewTool = Tool.define<typeof parameters, BrowserViewMetadata>("browser_view", {
  description:
    "Control the browser workspace panel. Show or hide the browser workspace UI, switch focus to the browser tab, or query the workspace open state. This does not affect CDP or the running browser — only the frontend view.",
  parameters,
  async execute(params) {
    switch (params.action) {
      case "show":
        return {
          title: "Browser workspace shown",
          output: "Browser workspace panel is now visible.",
          metadata: { action: "show" },
        }
      case "hide":
        return {
          title: "Browser workspace hidden",
          output: "Browser workspace panel is now hidden.",
          metadata: { action: "hide" },
        }
      case "focus":
        return {
          title: "Browser focused",
          output: "Active tool switched to browser.",
          metadata: { action: "focus" },
        }
      case "status":
        return {
          title: "Browser workspace status",
          output: "Browser workspace is open.",
          metadata: { action: "status", workspaceOpen: true },
        }
    }
  },
})
