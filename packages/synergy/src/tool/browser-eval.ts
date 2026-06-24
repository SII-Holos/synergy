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
    throwOnSideEffect: z
      .boolean()
      .optional()
      .describe("Enable CDP throwOnSideEffect. Set automatically by readonly mode."),
  }),
  async execute(params, ctx) {
    if (!BrowserEval.isEvalAllowed(params.mode)) {
      throw new Error(`Eval mode '${params.mode}' is not allowed.`)
    }

    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const activityKind = params.mode === "trusted" ? "acting" : "reading"
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      activityKind,
      "browser_eval",
      `Evaluating ${params.mode} script`,
      async () => {
        const start = Date.now()

        const isReadonly = params.mode === "readonly"
        const evalPayload = isReadonly
          ? BrowserEval.buildReadonlyEval(params.expression)
          : BrowserEval.buildTrustedEval(params.expression)

        // Readonly eval routes through Playwright CDP session Runtime.evaluate with throwOnSideEffect
        // Trusted eval uses Playwright page.evaluate (buildPageEval) when permission is granted.
        // For backward compatibility, tab.evaluate forwards to page.evaluate.
        const raw = await tab.evaluate(evalPayload.expression, {
          throwOnSideEffect: isReadonly ? true : undefined,
        })
        const duration = Date.now() - start
        const output = BrowserEval.sanitizeEvalResult(raw, params.maxBytes)

        return {
          title: `Eval result (${params.mode}, ${duration}ms)`,
          output,
          metadata: { mode: params.mode, duration },
        }
      },
    )
  },
})
