import z from "zod"
import { BrowserBackendResultSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "../../tool/tool"
import { BrowserToolHelper, formatSettleSummary, withUnknownOutcomeGuidance } from "./browser-shared"
import { BrowserOwner } from "../owner"

const navigationActions = ["goto", "back", "forward", "reload", "stop", "resume", "close", "current"] as const
const MAX_CURRENT_ERROR_MESSAGE_CHARS = 2_000

const parameters = z
  .object({
    action: z.enum(navigationActions),
    url: z.string().min(1).max(20_000).optional().describe("Required only for goto."),
    ignoreCache: z.boolean().optional().describe("Valid only for reload."),
    settleMode: z
      .enum(["networkquiet", "load", "none"])
      .optional()
      .describe(
        "How long to wait after navigation before returning. load is the default for agent navigation (up to 15s); networkquiet waits up to settleTimeoutMs for the page to stop loading and go quiet; none returns immediately.",
      ),
    settleTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .optional()
      .describe(
        "Maximum milliseconds to wait for the page to settle (default 15s for navigation, hard cap 30s). A timeout does not fail the navigation; the result reports settled:false so you can decide what to wait for with browser_wait.",
      ),
    includeSnapshot: z
      .boolean()
      .optional()
      .describe(
        "Return a fresh accessibility snapshot after navigation settles (default true). Set false when the destination is a download or you only need the URL/title.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "goto" && !value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url is required for goto." })
    }
    if (value.action !== "goto" && value.url !== undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url is valid only for goto." })
    }
    if (value.action !== "reload" && value.ignoreCache !== undefined) {
      ctx.addIssue({ code: "custom", path: ["ignoreCache"], message: "ignoreCache is valid only for reload." })
    }
    if (value.action !== "goto" && value.action !== "back" && value.action !== "forward" && value.action !== "reload") {
      for (const key of ["settleMode", "settleTimeoutMs", "includeSnapshot"] as const) {
        if (value[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is valid only for goto, back, forward, or reload.`,
          })
        }
      }
    }
  })

interface BrowserNavigationMetadata {
  status: string
  pageId?: string
  url?: string
  title?: string
  isLoading?: boolean
  action?: string
  resultType?: string
  settled?: boolean
  settleReason?: string
  settleElapsedMs?: number
  inflightRequests?: number
  elementsCount?: number
  snapshotId?: string
  lastError?: { code: string; suggestedAction?: string }
}

export const BrowserNavigationTool = Tool.define<typeof parameters, BrowserNavigationMetadata>("browser_navigation", {
  description:
    "Navigate, resume, close, or read the one browser page owned by the current session. Agent navigation uses load for up to 15s by default; actions use networkquiet for up to 10s; every settle request has a 30s hard cap and returns current page state plus a best-effort snapshot. A settle timeout reports settled:false rather than an action failure, so inspect the current state before using browser_wait for a specific condition. Results report observed engine state and never claim business completion.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    if (params.action === "current") {
      const session = await BrowserToolHelper.getOrCreateSession(owner)
      const page = session.page ?? session.descriptor
      const isLoading = session.page?.loading ?? false
      const lastError = session.error
      const lines = page
        ? [
            `Status: ${session.status}`,
            `Loading: ${isLoading ? "yes" : "no"}`,
            `URL: ${page.url}`,
            `Title: ${page.title || (isLoading ? "(loading)" : "(empty)")}`,
          ]
        : ["No browser page is open."]
      if (lastError) {
        lines.push(`Last error: ${lastError.code} — ${lastError.message.slice(0, MAX_CURRENT_ERROR_MESSAGE_CHARS)}`)
        if (lastError.suggestedAction) {
          lines.push(`Suggested next step: ${lastError.suggestedAction.slice(0, MAX_CURRENT_ERROR_MESSAGE_CHARS)}`)
        }
      }
      return {
        title: page ? "Current browser page" : "No browser page",
        output: lines.join("\n"),
        metadata: {
          status: session.status,
          pageId: page?.id,
          url: page?.url,
          title: page?.title,
          isLoading,
          ...(lastError ? { lastError: { code: lastError.code, suggestedAction: lastError.suggestedAction } } : {}),
        },
      }
    }

    let result
    try {
      const settleFields = {
        ...(params.settleMode !== undefined ? { settleMode: params.settleMode } : {}),
        ...(params.settleTimeoutMs !== undefined ? { settleTimeoutMs: params.settleTimeoutMs } : {}),
        ...(params.includeSnapshot !== undefined ? { includeSnapshot: params.includeSnapshot } : {}),
      }
      if (params.action === "goto") {
        result = await BrowserToolHelper.execute(ctx, {
          type: "navigate",
          url: params.url!,
          source: "agent",
          ...settleFields,
        })
      } else if (params.action === "back")
        result = await BrowserToolHelper.execute(ctx, { type: "history", direction: "back", ...settleFields })
      else if (params.action === "forward")
        result = await BrowserToolHelper.execute(ctx, { type: "history", direction: "forward", ...settleFields })
      else if (params.action === "reload")
        result = await BrowserToolHelper.execute(ctx, {
          type: "reload",
          ignoreCache: params.ignoreCache,
          ...settleFields,
        })
      else result = await BrowserToolHelper.execute(ctx, { type: params.action })
    } catch (error) {
      throw withUnknownOutcomeGuidance(error, `browser_navigation ${params.action}`)
    }

    const session = await BrowserToolHelper.getOrCreateSession(owner)
    const page = session.page ?? session.descriptor
    const resultPage = result.type === "navigation" || result.type === "page" ? result.page : undefined
    const isLoading = resultPage?.isLoading ?? session.page?.loading ?? false
    const snapshot =
      result.type === "navigation" || result.type === "action"
        ? BrowserBackendResultSchema.safeParse(result.snapshot)
        : { success: false as const }
    const snapshotResult = snapshot.success && snapshot.data.type === "snapshot" ? snapshot.data : null
    const settled = result.type === "navigation" || result.type === "action" ? (result.settled ?? undefined) : undefined
    const settleReason =
      result.type === "navigation" || result.type === "action" ? (result.settleReason ?? undefined) : undefined
    const settleElapsedMs =
      result.type === "navigation" || result.type === "action" ? (result.settleElapsedMs ?? undefined) : undefined
    const inflightRequests =
      result.type === "navigation" || result.type === "action" ? (result.inflightRequests ?? undefined) : undefined

    const lines = [
      `Loading: ${isLoading ? "yes" : "no"}`,
      `URL: ${page?.url ?? "(closed)"}`,
      `Title: ${page?.title || (isLoading ? "(loading)" : "(empty)")}`,
    ]
    const settleLine = formatSettleSummary({
      settled,
      settleReason,
      settleElapsedMs,
      inflightRequests,
      snapshotAvailable: Boolean(snapshotResult),
      snapshotUnavailable: settled !== undefined && !snapshotResult && params.includeSnapshot !== false,
    })
    if (settleLine) lines.push(settleLine)
    if (snapshotResult)
      lines.push(`Snapshot: ${snapshotResult.snapshotId} (${snapshotResult.elements.length} elements)`)
    else if (settled !== undefined)
      lines.push(params.includeSnapshot === false ? "Snapshot: not requested" : "Snapshot: unavailable")

    return {
      title: `Browser navigation: ${params.action}`,
      output: page ? lines.join("\n") : "Browser page closed.",
      metadata: {
        action: params.action,
        resultType: result.type,
        status: session.status,
        pageId: page?.id,
        url: page?.url,
        title: page?.title,
        isLoading,
        ...(settled !== undefined ? { settled } : {}),
        ...(settleReason ? { settleReason } : {}),
        ...(settleElapsedMs !== undefined ? { settleElapsedMs } : {}),
        ...(inflightRequests !== undefined ? { inflightRequests } : {}),
        ...(snapshotResult
          ? { elementsCount: snapshotResult.elements.length, snapshotId: snapshotResult.snapshotId }
          : {}),
      },
    }
  },
})
