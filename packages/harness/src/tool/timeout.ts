import type { ToolTimeoutMetadata, ToolTimeoutSource } from "@ericsanchezok/synergy-util/tool-timeout"

export type { ToolTimeoutMetadata, ToolTimeoutSource }

export namespace ToolTimeout {
  export type Source = ToolTimeoutSource
  export type Metadata = ToolTimeoutMetadata

  export const DEFAULTS = {
    globMs: 15_000,
    listMs: 15_000,
    scanFilesMs: 10_000,
    astGrepMs: 60_000,
    documentExtractMs: 60_000,
    webfetchMs: 30_000,
    webfetchMaxMs: 120_000,
    browserWaitMs: 10_000,
    browserWaitMaxMs: 60_000,
    browserSettleMs: 30_000,
    browserDownloadsWaitMs: 30_000,
    browserHelperWaitMs: 30_000,
    browserLocatorMs: 5_000,
    connectMs: 30_000,
    taskAutoBackgroundMs: 300_000,
    taskOutputWaitMs: 300_000,
    processPollWaitMs: 30_000,
    questionMs: 3_600_000,
    lookAtMs: 120_000,
    bashHardCeilingMs: 86_400_000,
    bashAutoBackgroundMs: 30_000,
  } as const

  const SETTLING_NAVIGATION_ACTIONS = new Set(["goto", "back", "forward", "reload"])

  export function create(input: { toolTimeoutMs: number; operationTimeoutMs?: number; source?: Source }): Metadata {
    const operationTimeoutMs = normalizeMs(input.operationTimeoutMs)
    return {
      toolTimeoutMs: input.toolTimeoutMs,
      ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
      displayMs: operationTimeoutMs ?? input.toolTimeoutMs,
      source: operationTimeoutMs !== undefined ? (input.source ?? "wait") : "tool_timeout",
    }
  }

  export function withOperation(
    base: Metadata | undefined,
    operationTimeoutMs: number | undefined,
    source: Source,
  ): Metadata | undefined {
    if (!base) return undefined
    return create({
      toolTimeoutMs: base.toolTimeoutMs,
      operationTimeoutMs,
      source,
    })
  }

  export function mergeMetadata(
    existing: Record<string, any> | undefined,
    next: Record<string, any> | undefined,
  ): Record<string, any> | undefined {
    if (!next) return existing
    if (!existing) return next

    const existingDisplay =
      existing.display && typeof existing.display === "object" && !Array.isArray(existing.display)
        ? existing.display
        : undefined
    const nextDisplay =
      next.display && typeof next.display === "object" && !Array.isArray(next.display) ? next.display : undefined
    const existingMedia =
      existingDisplay?.media && typeof existingDisplay.media === "object" && !Array.isArray(existingDisplay.media)
        ? existingDisplay.media
        : undefined
    const nextMedia =
      nextDisplay?.media && typeof nextDisplay.media === "object" && !Array.isArray(nextDisplay.media)
        ? nextDisplay.media
        : undefined
    const display =
      existingDisplay || nextDisplay
        ? {
            ...(existingDisplay ?? {}),
            ...(nextDisplay ?? {}),
            ...(existingMedia || nextMedia ? { media: { ...(existingMedia ?? {}), ...(nextMedia ?? {}) } } : {}),
          }
        : undefined

    return {
      ...existing,
      ...next,
      ...(display ? { display } : {}),
    }
  }

  export function metadataForTool(input: {
    tool: string
    args: Record<string, any>
    toolTimeoutMs: number
    mcpCallTimeoutMs?: number
  }): Metadata {
    const operation = operationForTool(input.tool, input.args, input.mcpCallTimeoutMs)
    return create({
      toolTimeoutMs: input.toolTimeoutMs,
      operationTimeoutMs: operation?.timeoutMs,
      source: operation?.source,
    })
  }

  export function scheduledTimeoutLabel(timeoutMs: number | undefined): string | undefined {
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
    return `timeout ${formatDuration(timeoutMs)}`
  }

  function operationForTool(
    tool: string,
    args: Record<string, any>,
    mcpCallTimeoutMs: number | undefined,
  ): { timeoutMs: number; source: Source } | undefined {
    switch (tool) {
      case "glob":
        return { timeoutMs: DEFAULTS.globMs, source: "search" }
      case "list":
        return { timeoutMs: DEFAULTS.listMs, source: "search" }
      case "scan_files":
        return {
          timeoutMs: Math.max(secondsToMs(args.timeoutSeconds, DEFAULTS.scanFilesMs), 1_000),
          source: "search",
        }
      case "ast_grep":
      case "parse_code":
        return { timeoutMs: DEFAULTS.astGrepMs, source: "search" }
      case "scan_document":
        return { timeoutMs: DEFAULTS.documentExtractMs, source: "document_extract" }
      case "webfetch":
        return {
          timeoutMs: Math.min(secondsToMs(args.timeoutSeconds, DEFAULTS.webfetchMs), DEFAULTS.webfetchMaxMs),
          source: "fetch",
        }
      case "browser_wait":
        return {
          timeoutMs: clampSeconds(args.timeoutSeconds, DEFAULTS.browserWaitMs, 1, DEFAULTS.browserWaitMaxMs / 1_000),
          source: "wait",
        }
      case "browser_action":
        return {
          timeoutMs: normalizeMs(args.action?.settleTimeoutMs ?? args.settleTimeoutMs) ?? DEFAULTS.browserSettleMs,
          source: "wait",
        }
      case "browser_navigation": {
        if (args.action !== undefined && !SETTLING_NAVIGATION_ACTIONS.has(String(args.action))) return undefined
        return {
          timeoutMs: normalizeMs(args.settleTimeoutMs) ?? DEFAULTS.browserSettleMs,
          source: "wait",
        }
      }
      case "browser_downloads":
        if (args.action !== "wait") return undefined
        return {
          timeoutMs: secondsToMs(args.timeoutSeconds, DEFAULTS.browserDownloadsWaitMs),
          source: "wait",
        }
      case "connect":
        if (args.action !== "open" && args.action !== "close") return undefined
        return { timeoutMs: DEFAULTS.connectMs, source: "remote_connect" }
      case "task":
        return { timeoutMs: DEFAULTS.taskAutoBackgroundMs, source: "auto_background" }
      case "task_output":
        if (!args.block) return undefined
        return { timeoutMs: secondsToMs(args.timeoutSeconds, DEFAULTS.taskOutputWaitMs), source: "wait" }
      case "bash":
        // `yieldSeconds` is the only timing argument the model can send (the bash
        // schema is strict); its window auto-backgrounds rather than aborting.
        return {
          timeoutMs: secondsToMs(args.yieldSeconds, DEFAULTS.bashAutoBackgroundMs),
          source: "auto_background",
        }
      case "process":
        if (args.action !== "poll" || !args.block) return undefined
        return { timeoutMs: secondsToMs(args.timeoutSeconds, DEFAULTS.processPollWaitMs), source: "wait" }
      case "question":
        return { timeoutMs: DEFAULTS.questionMs, source: "question" }
      case "look_at":
        return { timeoutMs: secondsToMs(args.timeoutSeconds, DEFAULTS.lookAtMs), source: "vision" }
      default:
        if (mcpCallTimeoutMs !== undefined) return { timeoutMs: mcpCallTimeoutMs, source: "wait" }
        return undefined
    }
  }

  function normalizeMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
    return value
  }

  function secondsToMs(value: unknown, fallbackMs: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs
    return value * 1_000
  }

  function clampSeconds(value: unknown, fallbackMs: number, minSeconds: number, maxSeconds: number): number {
    const seconds = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallbackMs / 1_000
    return Math.round(Math.min(Math.max(seconds, minSeconds), maxSeconds) * 1_000)
  }

  function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1_000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (remainingSeconds === 0) return `${minutes}m`
    return `${minutes}m ${remainingSeconds}s`
  }
}
