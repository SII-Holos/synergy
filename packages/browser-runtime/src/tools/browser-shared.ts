import {
  BrowserProtocolError,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserSnapshotElement,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserProfiles } from "../profiles.js"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserCommandService } from "../command-service.js"
import { BrowserOwner } from "../owner.js"
import type { BrowserPageBackend } from "../page.js"
import type { BrowserSession } from "../types.js"

export class BrowserPageNotFoundError extends BrowserProtocolError {
  constructor(pageId?: string) {
    super({
      code: "browser_page_missing",
      message: pageId ? `Browser page not found: ${pageId}` : "No browser page is open.",
      retryable: false,
      pageId,
      suggestedAction: "List pages with browser_navigation, then open or resume a page.",
    })
    this.name = "BrowserPageNotFoundError"
  }
}

export namespace BrowserToolHelper {
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return BrowserCommandService.session(owner)
  }

  export async function execute(
    ctx: Tool.Context,
    pageId: string,
    command: BrowserBackendCommand,
    suffix: string = command.type,
  ): Promise<BrowserBackendResult> {
    const owner = BrowserOwner.fromToolContext(ctx)
    return BrowserCommandService.execute(owner, {
      command,
      pageId,
      authorize: ({ profileId, url, command }) =>
        authorize(ctx, profileId, url, command.type === "upload" ? "uploads" : "access"),
      commandId: commandId(ctx, suffix),
      signal: ctx.abort,
    })
  }

  export async function executeForOwner(
    owner: BrowserOwner.Info,
    pageId: string,
    command: BrowserBackendCommand,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<BrowserBackendResult> {
    return BrowserCommandService.execute(owner, { pageId, command, commandId, signal })
  }

  export async function authorize(
    ctx: Tool.Context,
    profileId: string,
    url: string,
    operation: "access" | "uploads" | "downloads",
  ): Promise<void> {
    const profile = await BrowserProfiles.requireEnabled(profileId)
    const origin = new URL(url).origin
    const policy = profile.origins[origin]?.[operation] ?? "inherit"
    if (policy === "inherit" || policy === "allow") return
    await ctx.ask({
      permission: `browser_identity_${operation}`,
      patterns: [`${profile.id}:${profile.revision}:${origin}`],
      metadata: {
        capability:
          operation === "access" ? "browser_interact" : operation === "uploads" ? "browser_upload" : "browser_download",
        resourcePolicy: policy,
        identity: profile.name,
        origin,
        operation,
      },
    })
    const fresh = await BrowserProfiles.requireEnabled(profileId)
    if (fresh.revision !== profile.revision)
      throw new BrowserProtocolError({
        code: "browser_permission_changed",
        message: "Identity permissions changed. Review the page before continuing.",
        retryable: true,
      })
  }

  export async function getPage(owner: BrowserOwner.Info, pageId: string): Promise<BrowserPageBackend> {
    const session = await BrowserCommandService.session(owner)
    const page = session.getPage(pageId)
    if (!page) throw new BrowserPageNotFoundError(pageId)
    return page
  }

  export async function resolvePage(ctx: Tool.Context, pageId: string): Promise<BrowserPageBackend> {
    return getPage(BrowserOwner.fromToolContext(ctx), pageId)
  }

  export async function markActivity(
    ctx: Tool.Context,
    page: BrowserPageBackend,
    kind: "reading" | "acting",
    tool: string,
    label: string,
  ): Promise<void> {
    const session = await BrowserCommandService.session(BrowserOwner.fromToolContext(ctx))
    await session.notifyAgentActivity({
      pageId: page.id,
      url: page.url,
      title: page.title,
      kind,
      tool,
      label,
    })
  }

  export async function markIdle(ctx: Tool.Context, page: BrowserPageBackend, tool: string): Promise<void> {
    const session = await BrowserCommandService.session(BrowserOwner.fromToolContext(ctx))
    await session.notifyAgentActivity({
      pageId: page.id,
      url: page.url,
      title: page.title,
      kind: "idle",
      tool,
      label: "Idle",
    })
  }

  export async function withActivity<T>(
    ctx: Tool.Context,
    page: BrowserPageBackend,
    kind: "reading" | "acting",
    tool: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await markActivity(ctx, page, kind, tool, label)
    try {
      return await fn()
    } finally {
      await markIdle(ctx, page, tool)
    }
  }
}

function commandId(ctx: Tool.Context, suffix: string): string {
  return `${ctx.callID ?? ctx.messageID}:${suffix}`
}

interface FormatOptions {
  interactiveOnly?: boolean
  maxDepth?: number
}

export function truncateBrowserOutput(value: string, maxChars = 100_000): { output: string; truncated: boolean } {
  if (value.length <= maxChars) return { output: value, truncated: false }
  return { output: `${value.slice(0, maxChars)}\n…(truncated)`, truncated: true }
}

export function formatBrowserJSON(value: unknown, maxChars = 100_000): { output: string; truncated: boolean } {
  return truncateBrowserOutput(JSON.stringify(value, null, 2) ?? String(value), maxChars)
}

const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "slider",
  "switch",
  "page",
  "option",
])

export function formatSnapshotText(
  elements: BrowserSnapshotElement[],
  options: FormatOptions = {},
): { output: string; truncated: boolean } {
  const filtered = elements.filter(
    (element) =>
      (!options.interactiveOnly || interactiveRoles.has(element.role)) &&
      (options.maxDepth === undefined || element.depth <= options.maxDepth),
  )
  if (filtered.length === 0) return { output: "(no matching accessible elements)", truncated: false }
  return truncateBrowserOutput(
    filtered
      .map((element) => {
        const value = element.value ? ` value=${JSON.stringify(element.value)}` : ""
        const description = element.description ? ` description=${JSON.stringify(element.description)}` : ""
        return `${"  ".repeat(element.depth)}${element.ref} ${element.role} ${JSON.stringify(element.name)}${value}${description}`
      })
      .join("\n"),
  )
}

export interface FormatSettleInput {
  settled?: boolean
  settleReason?: string
  settleElapsedMs?: number
  /** Present when the result type exposes inflight request counts (navigation/action). */
  inflightRequests?: number
  /** True when the result type exposes snapshot availability and the snapshot is usable. */
  snapshotAvailable?: boolean
  /** True when the result type exposes snapshot availability but the snapshot is unusable. */
  snapshotUnavailable?: boolean
}

export function formatSettleSummary(input: FormatSettleInput): string | undefined {
  if (input.settled === undefined) return undefined
  const reason = input.settleReason ? ` (${input.settleReason})` : ""
  const elapsed = input.settleElapsedMs !== undefined ? ` after ${input.settleElapsedMs}ms` : ""
  const inflight =
    input.inflightRequests !== undefined && input.inflightRequests > 0
      ? `; ${input.inflightRequests} request(s) still in flight`
      : ""
  const lines = [`Settled: ${input.settled ? "yes" : "no"}${reason}${elapsed}${inflight}`]
  if (!input.settled) {
    lines.push("Page still loading. Inspect it before retrying; use browser_wait for a specific condition.")
  } else if (input.snapshotUnavailable) {
    lines.push("Snapshot unavailable — inspect the current page with browser_snapshot or browser_read.")
  } else if (input.snapshotAvailable) {
    lines.push("Snapshot evidence is included below.")
  }
  return lines.join("\n")
}

/**
 * Claim ceiling for dispatched browser actions: the engine only reports what was
 * dispatched and what the page was observed to do, never business completion.
 */
export function formatActionEvidenceNote(input: { snapshotAvailable: boolean; settleSkipped?: boolean }): string {
  return input.snapshotAvailable
    ? "Verify completion in the observed page state."
    : "Action dispatched. Inspect the page to verify completion."
}

/**
 * Errors that mean the command left the host or page before a verdict: the side
 * effect may or may not have been applied, so the old commandId must never be
 * re-executed. All other errors keep their own guidance.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  "browser_command_aborted",
  "browser_host_timeout",
  "browser_host_unavailable",
  "browser_host_pending",
  "browser_session_closing",
  "browser_command_failed",
  "browser_result_too_large",
])

const IDEMPOTENT_NAVIGATION_COMMANDS = new Set([
  "browser_navigation resume",
  "browser_navigation close",
  "browser_navigation stop",
])

export function withUnknownOutcomeGuidance(error: unknown, commandType: string): unknown {
  if (!(error instanceof BrowserProtocolError)) return error
  if (IDEMPOTENT_NAVIGATION_COMMANDS.has(commandType)) return error
  if (!UNKNOWN_OUTCOME_CODES.has(error.code) || !error.commandId) return error
  const guidance =
    `The outcome of ${commandType} is unknown: it may or may not have been applied. Do NOT re-execute it or retry the same call. ` +
    `Verify first with browser_navigation current, browser_snapshot, or browser_read, then continue with a fresh call.`
  const data = error.toJSON()
  return new BrowserProtocolError(
    {
      ...data,
      message: `${data.message}\n${guidance}`,
      suggestedAction: guidance,
    },
    { cause: error },
  )
}
