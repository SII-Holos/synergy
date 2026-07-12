import z from "zod"
import { BrowserActionSchema, BrowserBackendResultSchema, type BrowserAction } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper, formatSnapshotText } from "./browser-shared"

export const BrowserActionTool = Tool.define("browser_action", {
  description:
    'Perform one deterministic browser interaction. Prefer a fresh snapshot ref. Label locators target labelled form controls; use role/name for buttons. For select, strings match HTML option values; use {label: "Visible text"} for displayed labels. Set includeSnapshot when the next step depends on the changed DOM. Same-page actions are serialized and should be issued sequentially.',
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
        const snapshot = BrowserBackendResultSchema.safeParse(result.snapshot)
        const snapshotResult = snapshot.success && snapshot.data.type === "snapshot" ? snapshot.data : null
        const formatted = snapshotResult ? formatSnapshotText(snapshotResult.elements) : null
        const summary = actionSummary(params.action)
        return {
          title: `Browser ${params.action.type}`,
          output: snapshotResult
            ? `${summary}\nsnapshotId: ${snapshotResult.snapshotId}\n${formatted!.output}`
            : summary,
          metadata: {
            pageId: page.id,
            action: params.action.type,
            snapshot: result.snapshot,
            outputTruncated: formatted?.truncated ?? false,
          },
        }
      },
    )
  },
  formatValidationError() {
    return 'Invalid browser_action input. Select by value with {"type":"select","target":{"kind":"role","role":"combobox","name":"Priority"},"values":["high"]}; select displayed text with "values":[{"label":"High"}].'
  },
})

function actionSummary(action: BrowserAction): string {
  if (action.type === "select") {
    return `Selected ${action.values.map((value) => (typeof value === "string" ? `value ${JSON.stringify(value)}` : JSON.stringify(value))).join(", ")}.`
  }
  if (action.type === "scroll") {
    return `Scrolled ${action.target ? "the target" : "the page"} by (${action.deltaX}, ${action.deltaY}) CSS pixels.`
  }
  if (action.type === "fill") return `Filled the target with ${action.value.length} characters.`
  if (action.type === "type") return `Typed ${action.value.length} characters.`
  if (action.type === "setChecked") return `Set the target checked state to ${action.checked}.`
  if (action.type === "press") return `Pressed ${JSON.stringify(action.key)}.`
  return `Completed ${action.type}.`
}
