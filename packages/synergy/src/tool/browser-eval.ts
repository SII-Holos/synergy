import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserEvalTool = Tool.define("browser_eval", {
  description:
    "Evaluate JavaScript in the current page. readonly runs with CDP side-effect rejection; trusted permits mutations and requires its dedicated capability.",
  parameters: z
    .object({
      expression: z.string().min(1).max(1_000_000),
      mode: z.enum(["readonly", "trusted"]).default("readonly"),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
      maxChars: z.number().int().min(1).max(200_000).default(64_000),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      params.mode === "trusted" ? "acting" : "reading",
      "browser_eval",
      `Evaluating ${params.mode} script`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, {
          type: "evaluate",
          mode: params.mode,
          expression: params.expression,
          timeoutMs: params.timeoutMs,
        })
        if (result.type !== "evaluation") throw new Error("Browser eval returned an unexpected result.")
        const raw = JSON.stringify(result.value, null, 2) ?? String(result.value)
        const output = raw.length > params.maxChars ? `${raw.slice(0, params.maxChars)}\n…(truncated)` : raw
        return {
          title: `Browser eval (${params.mode})`,
          output,
          metadata: { pageId: page.id, mode: params.mode, truncated: raw.length > params.maxChars },
        }
      },
    )
  },
})
