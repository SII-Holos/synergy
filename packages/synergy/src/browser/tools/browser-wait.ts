import z from "zod"
import { BrowserWaitConditionSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "../../tool/tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserWaitTool = Tool.define("browser_wait", {
  description:
    "Wait for a specific page condition: load state, URL, title, text, locator state, download, or dialog. Actions and navigation already settle the page by default (up to 30s), so use this tool only for conditions the engine cannot infer — a business result, an async task completion, a specific error message, a download, or a dialog. Prefer a concrete condition (text/locator/url/load) over pure timing waits. Default timeout is 10 seconds; raise timeoutMs for slow asynchronous operations.",
  parameters: z
    .object({
      condition: BrowserWaitConditionSchema,
      timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      "reading",
      "browser_wait",
      "Waiting for page condition",
      async () => {
        const result = await BrowserToolHelper.execute(ctx, {
          type: "wait",
          condition: params.condition,
          timeoutMs: params.timeoutMs,
        })
        if (result.type !== "wait") throw new Error("Browser wait returned an unexpected result.")
        const pageState = result.page
        return {
          title: "Browser wait satisfied",
          output: `Condition ${params.condition.type} was satisfied${result.elapsedMs !== undefined ? ` in ${result.elapsedMs}ms` : ` within ${params.timeoutMs}ms`}.`,
          metadata: {
            pageId: page.id,
            condition: params.condition,
            timeoutMs: params.timeoutMs,
            matched: result.matched,
            ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
            ...(pageState ? { url: pageState.url, title: pageState.title, isLoading: pageState.isLoading } : {}),
          },
        }
      },
    )
  },
  formatValidationError() {
    return 'Invalid browser_wait input. Example: {"condition":{"type":"locator","locator":{"kind":"role","role":"button","name":"Continue"},"state":"visible"},"timeoutMs":10000}'
  },
})
