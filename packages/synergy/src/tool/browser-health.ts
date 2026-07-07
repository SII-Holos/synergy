import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"
import { BrowserHostControl } from "../browser/host-control"

export const BrowserHealthTool = Tool.define("browser_health", {
  description:
    "Check the health and connectivity status of the current browser session page. Returns whether the page is available, its URL and title, host connection status (pending/ready/detached/failed), and recovery guidance when the page is not available.",
  parameters: z.object({
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)

    // Check host connection status first
    const hostStatus = BrowserHostControl.has(owner)
      ? BrowserHostControl.status(owner, params.pageId ?? null)
      : ("detached" as const)

    let pageStatus: "available" | "missing" | "error" = "missing"
    let pageUrl = ""
    let pageTitle = ""
    let pageLoading = false

    try {
      const tab = await BrowserToolHelper.getPage(owner, params.pageId)
      pageStatus = "available"
      pageUrl = tab.url
      pageTitle = tab.title
      pageLoading = tab.loading
    } catch {
      pageStatus = "missing"
    }

    const healthy = pageStatus === "available" && hostStatus === "ready"

    const lines: string[] = [`Browser page: ${pageStatus}`, `Host connection: ${hostStatus}`, `Healthy: ${healthy}`]
    if (pageUrl) lines.push(`URL: ${pageUrl}`)
    if (pageTitle) lines.push(`Title: ${pageTitle}`)
    if (pageLoading) lines.push("⚠️ Page is currently loading")
    if (!healthy) {
      lines.push("")
      if (hostStatus !== "ready") {
        lines.push("Host is not connected. The browser workspace may not be open or may have disconnected.")
        lines.push("Recovery: Open the Browser Side Workspace panel, then use browser_navigate to recreate the page.")
      } else if (pageStatus !== "available") {
        lines.push("Page is not available. Use browser_navigate to create or restore the page.")
      }
    }

    return {
      title: `Browser health: ${healthy ? "healthy" : "unhealthy"}`,
      output: lines.join("\n"),
      metadata: {
        healthy,
        pageStatus,
        hostStatus,
        url: pageUrl,
        title: pageTitle,
        loading: pageLoading,
      },
    }
  },
})
