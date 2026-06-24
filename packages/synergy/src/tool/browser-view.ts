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
  workspaceOpen?: boolean | "unknown"
  workspaceTool?: "browser"
  workspaceCommand?: "show" | "hide" | "focus" | "status"
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
          output: "Requested the Browser workspace panel.",
          metadata: { action: "show", workspaceCommand: "show", workspaceTool: "browser", workspaceOpen: "unknown" },
        }
      case "hide":
        return {
          title: "Browser workspace hidden",
          output: "Requested hiding the Browser workspace panel.",
          metadata: { action: "hide", workspaceCommand: "hide", workspaceTool: "browser", workspaceOpen: "unknown" },
        }
      case "focus":
        return {
          title: "Browser focused",
          output: "Requested focus for the Browser workspace panel.",
          metadata: { action: "focus", workspaceCommand: "focus", workspaceTool: "browser", workspaceOpen: "unknown" },
        }
      case "status":
        return {
          title: "Browser workspace status",
          output: "Browser workspace frontend state is unknown from the server.",
          metadata: {
            action: "status",
            workspaceCommand: "status",
            workspaceTool: "browser",
            workspaceOpen: "unknown",
          },
        }
    }
  },
})
