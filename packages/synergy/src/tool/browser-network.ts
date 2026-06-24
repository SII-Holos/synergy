import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserPolicy } from "../browser/policy"

export const BrowserNetworkTool = Tool.define("browser_network", {
  description:
    "Get network requests from a browser tab's network buffer. Returns request details (URL, method, status, MIME type) with sensitive headers stripped. Use this to inspect page loading, API calls, and resource fetches.",
  parameters: z.object({
    tabId: z.string().describe("Browser tab ID. Uses the active tab if omitted.").optional(),
    maxEntries: z.number().describe("Maximum entries to return (default 20).").default(20).optional(),
    filter: z.string().describe("Optional regex pattern to filter requests by URL.").optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_network",
      "Reading network requests",
      async () => {
        const requests = await tab.networkRequests(params.maxEntries ?? 20)

        let filtered = requests
        if (params.filter) {
          let filterRegex: RegExp
          try {
            filterRegex = new RegExp(params.filter, "i")
          } catch {
            throw new Error(`Invalid regex filter: ${params.filter}`)
          }
          filtered = requests.filter((r) => filterRegex.test(r.url))
        }

        // Strip sensitive headers before formatting output
        const sanitized = filtered.map((r) => ({
          ...r,
          responseHeaders: r.responseHeaders ? BrowserPolicy.sanitizeHeaders(r.responseHeaders) : undefined,
        }))

        if (sanitized.length === 0) {
          return {
            title: `Network requests (0, tab: ${tab.id})`,
            output: "No network requests captured.",
            metadata: { requestCount: 0 },
          }
        }

        const lines = sanitized.map((req) => {
          const ts = new Date(req.timestamp).toISOString()
          const method = req.method.padEnd(7)
          const status = req.status != null ? String(req.status).padStart(3) : "---"
          const type = req.mimeType ?? "---"
          return `[${ts}] ${status} ${method} ${type} ${req.url}`
        })

        return {
          title: `Network requests (${sanitized.length}, tab: ${tab.id})`,
          output: lines.join("\n"),
          metadata: { requestCount: sanitized.length },
        }
      },
    )
  },
})
