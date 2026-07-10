import z from "zod"
import { BrowserActionSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserActionTool = Tool.define("browser_action", {
  description:
    "Perform one deterministic browser interaction. Targets use a snapshot ref, test id, role and accessible name, label, placeholder, text, standard CSS, XPath, or visual coordinates.",
  parameters: z.object({ action: BrowserActionSchema }).strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      "acting",
      "browser_action",
      `Running ${params.action.type}`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, { type: "action", action: params.action })
        if (result.type !== "action") throw new Error("Browser action returned an unexpected result.")
        return {
          title: `Browser ${params.action.type}`,
          output: `Completed ${params.action.type} on page ${page.id}.`,
          metadata: { pageId: page.id, action: params.action.type, snapshot: result.snapshot },
        }
      },
    )
  },
})
