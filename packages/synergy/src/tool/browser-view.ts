import z from "zod"
import { Tool } from "./tool"

const parameters = z.object({
  action: z
    .enum(["show", "hide", "focus", "status"])
    .describe(
      "show: open the Browser Side Workspace panel. hide: close the Side Workspace. focus: switch the Side Workspace to Browser. status: query current Side Workspace open state.",
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
    "Control the Browser Side Workspace panel. Show or hide the Browser UI, switch focus to the browser page, or query the Side Workspace open state. This does not affect CDP or the running browser — only the frontend view.",
  parameters,
  async execute(params) {
    switch (params.action) {
      case "show":
        return {
          title: "Browser workspace shown",
          output: "Requested the Browser Side Workspace panel.",
          metadata: { action: "show", workspaceCommand: "show", workspaceTool: "browser", workspaceOpen: "unknown" },
        }
      case "hide":
        return {
          title: "Browser workspace hidden",
          output: "Requested hiding the side workspace.",
          metadata: { action: "hide", workspaceCommand: "hide", workspaceTool: "browser", workspaceOpen: "unknown" },
        }
      case "focus":
        return {
          title: "Browser focused",
          output: "Requested focus for the Browser Side Workspace panel.",
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
