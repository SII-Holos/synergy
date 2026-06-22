import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserEval } from "../browser/eval"

export const BrowserEvalTool = Tool.define("browser_eval", {
  description:
    "Execute JavaScript in the browser page. Default readonly mode uses throwOnSideEffect to prevent DOM mutations. Trusted mode requires explicit permission.",
  parameters: z.object({
    expression: z.string().describe("JavaScript expression to evaluate in the page."),
    mode: z
      .enum(["readonly", "trusted"])
      .default("readonly")
      .describe("Eval mode: readonly=no side effects, trusted=allow mutations."),
    maxBytes: z.number().int().default(64000).describe("Maximum output size in bytes."),
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    if (!BrowserEval.isEvalAllowed(params.mode)) {
      throw new Error(`Eval mode '${params.mode}' is not allowed.`)
    }

    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const start = Date.now()
    const raw = await tab.evaluate(params.expression)
    const duration = Date.now() - start
    const output = BrowserEval.sanitizeEvalResult(raw, params.maxBytes)

    return {
      title: `Eval result (${params.mode}, ${duration}ms)`,
      output,
      metadata: { mode: params.mode, duration },
    }
  },
})
