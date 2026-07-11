import z from "zod"
import { Tool } from "./tool"
import { BrowserBroker } from "../browser/broker"
import { BrowserHostBrokerProcess } from "../browser/host-broker-process"

const parameters = z
  .object({
    action: z
      .enum(["show", "hide", "focus", "status"])
      .describe(
        "show: open the Browser Side Workspace panel. hide: close the Side Workspace. focus: switch the Side Workspace to Browser. status: query current host connection state.",
      ),
  })
  .strict()

interface BrowserViewMetadata {
  action: string
  workspaceOpen?: boolean | "unknown"
  workspaceTool?: "browser"
  workspaceCommand?: "show" | "hide" | "focus" | "status"
  hostStatus?: string
}

export const BrowserViewTool = Tool.define<typeof parameters, BrowserViewMetadata>("browser_view", {
  description:
    "Control the Browser Side Workspace panel. Show or hide the Browser UI, switch focus to the browser page, or query the Side Workspace open state. This does not affect CDP or the running browser — only the frontend view.",
  parameters,
  async execute(params) {
    const hostStatus = BrowserBroker.ready() ? "ready" : BrowserHostBrokerProcess.status()

    switch (params.action) {
      case "show":
        return {
          title: "Browser workspace shown",
          output: "Requested the Browser Side Workspace panel.",
          metadata: {
            action: "show",
            workspaceCommand: "show",
            workspaceTool: "browser",
            workspaceOpen: "unknown",
            hostStatus,
          },
        }
      case "hide":
        return {
          title: "Browser workspace hidden",
          output: "Requested hiding the side workspace.",
          metadata: {
            action: "hide",
            workspaceCommand: "hide",
            workspaceTool: "browser",
            workspaceOpen: "unknown",
            hostStatus,
          },
        }
      case "focus":
        return {
          title: "Browser focused",
          output: "Requested focus for the Browser Side Workspace panel.",
          metadata: {
            action: "focus",
            workspaceCommand: "focus",
            workspaceTool: "browser",
            workspaceOpen: "unknown",
            hostStatus,
          },
        }
      case "status":
        return {
          title: `Browser host: ${hostStatus}`,
          output: `Browser host connection status: ${hostStatus}`,
          metadata: {
            action: "status",
            workspaceCommand: "status",
            workspaceTool: "browser",
            workspaceOpen: hostStatus === "ready" ? true : "unknown",
            hostStatus,
          },
        }
    }
  },
})
