import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserEval } from "../browser/eval"
import { BrowserOwner } from "../browser/owner"

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
    pageId: z.string().optional(),
    throwOnSideEffect: z
      .boolean()
      .optional()
      .describe("Enable CDP throwOnSideEffect. Set automatically by readonly mode."),
  }),
  async execute(params, ctx) {
    if (!BrowserEval.isEvalAllowed(params.mode)) {
      throw new Error(`Eval mode '${params.mode}' is not allowed.`)
    }

    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
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

        const result = await BrowserToolHelper.executeControl(owner, {
          type: "evaluate",
          pageId: tab.id,
          expression: evalPayload.expression,
          throwOnSideEffect: isReadonly ? true : undefined,
        })
        if (result.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
        const raw = result.value
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
