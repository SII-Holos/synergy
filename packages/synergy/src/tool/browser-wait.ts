import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { ToolTimeout } from "./timeout"

const waitConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load") }),
  z.object({ type: z.literal("url"), contains: z.string() }),
  z.object({ type: z.literal("title"), contains: z.string() }),
])

export const BrowserWaitTool = Tool.define("browser_wait", {
  description:
    "Wait for a condition on the current browser page. Supports waiting for the page to finish loading, or for the URL/title to contain specific text. Returns whether the condition was met within the timeout.",
  parameters: z.object({
    condition: waitConditionSchema.describe("Condition to wait for"),
    timeout: z
      .number()
      .int()
      .min(500)
      .max(ToolTimeout.DEFAULTS.browserWaitMaxMs)
      .default(ToolTimeout.DEFAULTS.browserWaitMs)
      .describe(
        `Timeout in milliseconds. Max ${ToolTimeout.DEFAULTS.browserWaitMaxMs}. Default ${ToolTimeout.DEFAULTS.browserWaitMs}.`,
      ),
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_wait",
      "Waiting for page condition",
      async () => {
        const met = await tab.waitFor(params.condition, params.timeout)

        const conditionDesc =
          params.condition.type === "load"
            ? "page loaded"
            : `${params.condition.type} contains "${params.condition.contains}"`

        return {
          title: met ? `Wait satisfied` : `Wait timed out`,
          output: met
            ? `Condition met: ${conditionDesc} (after waiting)`
            : `Condition not met within ${params.timeout}ms: ${conditionDesc}`,
          metadata: {
            pageId: tab.id,
            condition: params.condition,
            timeout: params.timeout,
            satisfied: met,
            url: tab.url,
            title: tab.title,
          },
        }
      },
    )
  },
})
