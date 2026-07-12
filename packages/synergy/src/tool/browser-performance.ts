import z from "zod"
import fs from "node:fs/promises"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { ScopeContext } from "../scope/context"
import { BrowserExport } from "../browser/export"

export const BrowserPerformanceTool = Tool.define("browser_performance", {
  description: "Measure Web Vitals, long tasks and resource timing, or start/stop a CDP performance trace.",
  parameters: z
    .object({
      action: z.enum(["measure", "startTrace", "stopTrace"]),
      exportPath: z
        .string()
        .min(1)
        .max(20_000)
        .optional()
        .describe("Workspace-relative JSON path for a stopped trace."),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.exportPath !== undefined && value.action !== "stopTrace") {
        ctx.addIssue({ code: "custom", path: ["exportPath"], message: "exportPath is valid only with stopTrace." })
      }
    }),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const result = await BrowserToolHelper.execute(ctx, { type: "performance", action: params.action })
    if (result.type !== "data") throw new Error("Browser performance returned an unexpected result.")
    let exported: string | undefined
    if (params.exportPath) {
      if (params.action !== "stopTrace") throw new Error("exportPath is only valid with stopTrace.")
      exported = await BrowserExport.fileTarget(ScopeContext.current.directory, params.exportPath)
      await fs.writeFile(exported, JSON.stringify(result.data, null, 2), { flag: "wx", mode: 0o600 })
    }
    const data = result.data as Record<string, unknown>
    const traceEvents = Array.isArray(data.traceEvents) ? data.traceEvents : undefined
    const displayData = traceEvents ? { ...data, traceEvents: undefined, traceEventCount: traceEvents.length } : data
    const raw = JSON.stringify(displayData, null, 2)
    const output = raw.length > 64_000 ? `${raw.slice(0, 64_000)}\n…(truncated)` : raw
    return {
      title: `Browser performance: ${params.action}`,
      output: `${output}${exported ? `\nExported: ${exported}` : ""}`,
      metadata: { pageId: page.id, action: params.action, exported, traceEventCount: traceEvents?.length },
    }
  },
})
