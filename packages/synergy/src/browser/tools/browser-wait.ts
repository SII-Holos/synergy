import z from "zod"
import { BrowserWaitConditionSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "../../tool/tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserWaitTool = Tool.define("browser_wait", {
  description:
    "Wait for a specific page condition: load state, URL, title, text, locator state, download, or dialog. The result only reports that the requested condition was observed; it is never evidence of business completion. Actions settle with networkquiet for up to 10s and navigation with load for up to 15s by default (hard cap 30s), so use this tool for conditions the engine cannot infer, such as a business result, async task completion, specific error message, download, or dialog.",
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
