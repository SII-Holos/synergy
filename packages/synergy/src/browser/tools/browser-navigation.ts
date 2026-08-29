import z from "zod"
import { BrowserBackendResultSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "../../tool/tool"
import { BrowserToolHelper, formatSettleSummary } from "./browser-shared"
import { BrowserOwner } from "../owner"

const navigationActions = ["goto", "back", "forward", "reload", "stop", "resume", "close", "current"] as const

const parameters = z
  .object({
    action: z.enum(navigationActions),
    url: z.string().min(1).max(20_000).optional().describe("Required only for goto."),
    ignoreCache: z.boolean().optional().describe("Valid only for reload."),
    settleMode: z
      .enum(["networkquiet", "load", "none"])
      .optional()
      .describe(
        "How long to wait after navigation before returning. networkquiet (default) waits up to settleTimeoutMs for the page to stop loading and go quiet; load waits for the main frame load event; none returns immediately.",
      ),
    settleTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .optional()
      .describe(
        "Maximum milliseconds to wait for the page to settle (default 30s). A timeout does not fail the navigation; the result reports settled:false so you can decide whether to wait for a specific condition with browser_wait.",
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
  elementsCount?: number
  snapshotId?: string
}

export const BrowserNavigationTool = Tool.define<typeof parameters, BrowserNavigationMetadata>("browser_navigation", {
  description:
    "Navigate, resume, close, or read the one browser page owned by the current session. goto, back, forward, and reload settle the page by default (up to 30s, quiet-network strategy) and return a fresh snapshot; a settle timeout does not fail the navigation — it reports settled:false so you can decide whether to wait for a specific business condition with browser_wait. Only use browser_wait when the result you need is not the page itself (specific text, locator state, URL change, download, dialog). Close is terminal for the current page and should be tested only after all navigation, debugging, and external-site checks; a later goto creates a new page.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    if (params.action === "current") {
      const session = await BrowserToolHelper.getOrCreateSession(owner)
      const page = session.page ?? session.descriptor
      const isLoading = session.page?.loading ?? false
      return {
        title: page ? "Current browser page" : "No browser page",
        output: page
          ? `Status: ${session.status}\nLoading: ${isLoading ? "yes" : "no"}\nURL: ${page.url}\nTitle: ${page.title || (isLoading ? "(loading)" : "(empty)")}`
          : "No browser page is open.",
        metadata: {
          status: session.status,
          pageId: page?.id,
          url: page?.url,
          title: page?.title,
          isLoading,
        },
      }
    }

    let result
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

    const lines = [
      `Loading: ${isLoading ? "yes" : "no"}`,
      `URL: ${page?.url ?? "(closed)"}`,
      `Title: ${page?.title || (isLoading ? "(loading)" : "(empty)")}`,
    ]
    const settleLine = formatSettleSummary({ settled, settleReason, settleElapsedMs })
    if (settleLine) lines.push(settleLine)
    if (snapshotResult)
      lines.push(`Snapshot: ${snapshotResult.snapshotId} (${snapshotResult.elements.length} elements)`)

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
        ...(snapshotResult
          ? { elementsCount: snapshotResult.elements.length, snapshotId: snapshotResult.snapshotId }
          : {}),
      },
    }
  },
})
