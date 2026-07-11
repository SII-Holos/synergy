import z from "zod"
import { BrowserEmulationSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserEmulateTool = Tool.define("browser_emulate", {
  description:
    "Apply viewport, DPR, mobile/touch, color scheme, motion, forced colors, locale/timezone, CPU, or network emulation.",
  parameters: z.object({ emulation: BrowserEmulationSchema }).strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const result = await BrowserToolHelper.execute(ctx, { type: "emulate", emulation: params.emulation })
    if (result.type !== "page") throw new Error("Browser emulation returned an unexpected result.")
    return {
      title: "Browser emulation applied",
      output: `Applied emulation to ${result.page.url}.`,
      metadata: { pageId: page.id, emulation: params.emulation, page: result.page },
    }
  },
})
