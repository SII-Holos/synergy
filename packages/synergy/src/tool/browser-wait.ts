import z from "zod"
import { BrowserWaitConditionSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserWaitTool = Tool.define("browser_wait", {
  description: "Wait for load, URL, title, text, locator state, download, or dialog. Default timeout is 10 seconds.",
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
        return {
          title: "Browser wait satisfied",
          output: `Condition ${params.condition.type} was satisfied within ${params.timeoutMs}ms.`,
          metadata: {
            pageId: page.id,
            condition: params.condition,
            timeoutMs: params.timeoutMs,
            matched: result.matched,
          },
        }
      },
    )
  },
  formatValidationError() {
    return 'Invalid browser_wait input. Example: {"condition":{"type":"locator","locator":{"kind":"role","role":"button","name":"Continue"},"state":"visible"},"timeoutMs":10000}'
  },
})
