import {
  BrowserProtocolError,
  normalizeBrowserURL,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserSnapshotElement,
} from "@ericsanchezok/synergy-browser"
import type { Tool } from "./tool"
import { BrowserCommandService } from "../browser/command-service.js"
import { BrowserOwner } from "../browser/owner.js"
import { BlockedURLNavigationError, type BrowserPageBackend } from "../browser/page.js"
import type { BrowserSession } from "../browser/types.js"
import { BrowserNetworkGateway } from "../browser/network-gateway.js"

export class BrowserPageNotFoundError extends BrowserProtocolError {
  constructor(pageId?: string) {
    super({
      code: "browser_page_missing",
      message: pageId ? `Browser page not found: ${pageId}` : "No browser page is open.",
      retryable: false,
      pageId,
      suggestedAction: "Use browser_navigation with action goto or resume.",
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
    command: BrowserBackendCommand,
    suffix: string = command.type,
  ): Promise<BrowserBackendResult> {
    const owner = BrowserOwner.fromToolContext(ctx)
    return BrowserCommandService.execute(owner, {
      command,
      commandId: commandId(ctx, suffix),
      signal: ctx.abort,
    })
  }

  export async function executeForOwner(
    owner: BrowserOwner.Info,
    command: BrowserBackendCommand,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<BrowserBackendResult> {
    return BrowserCommandService.execute(owner, { command, commandId, signal })
  }

  export async function navigateWithPolicyApproval(ctx: Tool.Context, url: string): Promise<BrowserBackendResult> {
    const owner = BrowserOwner.fromToolContext(ctx)
    const normalized = normalizeBrowserURL(url)
    const command = { type: "navigate", url: normalized, source: "agent" } as const
    const privateNetworkGrant = await BrowserNetworkGateway.privateNetworkGrant(normalized)
    if (privateNetworkGrant) {
      await ctx.ask({
        permission: "browser_private_network",
        patterns: [new URL(normalized).hostname],
        metadata: {
          nonBypassable: true,
          capability: "browser_private_network",
          reason: "The browser destination resolves to a private-network address.",
        },
      })
    }
    try {
      return await BrowserCommandService.execute(owner, {
        command,
        commandId: commandId(ctx, "navigate"),
        signal: ctx.abort,
        privateNetworkGrant: privateNetworkGrant ?? undefined,
      })
    } catch (error) {
      if (!(error instanceof BlockedURLNavigationError)) throw error
      await ctx.ask({
        permission: "network_request",
        patterns: [error.url],
        metadata: {
          nonBypassable: false,
          capability: "network_request",
          reason: error.message,
        },
      })
      return BrowserCommandService.execute(owner, {
        command,
        commandId: commandId(ctx, "navigate-approved"),
        signal: ctx.abort,
        navigationGrant: normalized,
        privateNetworkGrant: privateNetworkGrant ?? undefined,
      })
    }
  }

  export async function getPage(owner: BrowserOwner.Info, pageId?: string): Promise<BrowserPageBackend> {
    const session = await BrowserCommandService.session(owner)
    if (pageId) {
      const page = session.getPage(pageId)
      if (!page) throw new BrowserPageNotFoundError(pageId)
      return page
    }
    if (!session.page) throw new BrowserPageNotFoundError(session.descriptor?.id)
    return session.page
  }

  export async function resolvePage(ctx: Tool.Context, pageId?: string): Promise<BrowserPageBackend> {
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
