import z from "zod"
import { BrowserActionSchema, BrowserBackendResultSchema, type BrowserAction } from "@ericsanchezok/synergy-browser"
import { Tool } from "../../tool/tool"
import {
  BrowserToolHelper,
  formatActionEvidenceNote,
  formatSettleSummary,
  formatSnapshotText,
  withUnknownOutcomeGuidance,
} from "./browser-shared"
export const BrowserActionTool = Tool.define("browser_action", {
  description:
    "Perform one deterministic browser interaction. The tool waits for the target to be actionable, dispatches the input, then settles with networkquiet for up to 10s by default (hard cap 30s) and returns a fresh accessibility snapshot when available. Agent navigation uses load for up to 15s. Use browser_wait only for a specific business condition; settled:false is a settle outcome, not an action failure, and results never claim business completion.",
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
        let result
        try {
          result = await BrowserToolHelper.execute(ctx, { type: "action", action: params.action })
        } catch (error) {
          throw withUnknownOutcomeGuidance(error, `browser_action ${params.action.type}`)
        }
        if (result.type !== "action") throw new Error("Browser action returned an unexpected result.")
        const snapshot = BrowserBackendResultSchema.safeParse(result.snapshot)
        const snapshotResult = snapshot.success && snapshot.data.type === "snapshot" ? snapshot.data : null
        const formatted = snapshotResult ? formatSnapshotText(snapshotResult.elements) : null
        const summary = actionSummary(params.action)
        const livePage = {
          url: result.page?.url ?? page.url,
          title: result.page?.title ?? page.title,
          loading: result.page?.isLoading ?? page.loading,
        }
        const settleLine = formatSettleSummary({
          settled: result.settled,
          settleReason: result.settleReason,
          settleElapsedMs: result.settleElapsedMs,
          inflightRequests: result.inflightRequests,
          snapshotAvailable: Boolean(snapshotResult),
          snapshotUnavailable: !snapshotResult,
        })
        const evidenceNote = formatActionEvidenceNote({
          snapshotAvailable: Boolean(snapshotResult),
          settleSkipped: result.settleReason === "none",
        })
        return {
          title: `Browser ${params.action.type}`,
          output: [
            summary,
            settleLine,
            evidenceNote,
            `Page: ${livePage.url}`,
            `Loading: ${livePage.loading ? "yes" : "no"}`,
            snapshotResult ? `snapshotId: ${snapshotResult.snapshotId}` : undefined,
            snapshotResult ? formatted!.output : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            pageId: page.id,
            actionType: params.action.type,
            ...targetSummary(params.action),
            ...(params.action.type === "fill" || params.action.type === "type"
              ? { valueLength: params.action.value.length }
              : {}),
            ...(result.settled !== undefined ? { settled: result.settled } : {}),
            ...(result.settleReason ? { settleReason: result.settleReason } : {}),
            ...(result.settleElapsedMs !== undefined ? { settleElapsedMs: result.settleElapsedMs } : {}),
            ...(result.inflightRequests !== undefined ? { inflightRequests: result.inflightRequests } : {}),
            url: livePage.url,
            title: livePage.title,
            isLoading: livePage.loading,
            ...(snapshotResult
              ? { elementsCount: snapshotResult.elements.length, snapshotId: snapshotResult.snapshotId }
              : {}),
            includeSnapshot: params.action.includeSnapshot ?? true,
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
    return `Dispatched select ${action.values
      .map((value) => (typeof value === "string" ? `value ${JSON.stringify(value)}` : JSON.stringify(value)))
      .join(", ")} on the target.`
  }
  if (action.type === "scroll") {
    return `Dispatched scroll of ${action.target ? "the target" : "the page"} by (${action.deltaX}, ${action.deltaY}) CSS pixels.`
  }
  if (action.type === "fill") return `Dispatched fill of ${action.value.length} characters into the target.`
  if (action.type === "type") return `Dispatched ${action.value.length} characters into the target.`
  if (action.type === "setChecked") return `Dispatched setChecked(${action.checked}) on the target.`
  if (action.type === "press") return `Dispatched key ${JSON.stringify(action.key)}.`
  if (action.type === "click" || action.type === "dblclick")
    return `Dispatched ${action.type} on the target${action.button && action.button !== "left" ? ` (${action.button} button)` : ""}.`
  return `Dispatched ${action.type}.`
}

function targetSummary(action: BrowserAction): {
  target?: { kind: string; role?: string; name?: string; ref?: string }
} {
  const target = "target" in action ? action.target : undefined
  if (!target || target.kind === "point") return {}
  const { kind, ...rest } = target
  const summary: { kind: string; role?: string; name?: string; ref?: string } = { kind }
  if ("role" in rest && typeof rest.role === "string") summary.role = rest.role
  if ("name" in rest && typeof rest.name === "string") summary.name = rest.name
  if ("ref" in rest && typeof rest.ref === "string") summary.ref = rest.ref
  return { target: summary }
}
