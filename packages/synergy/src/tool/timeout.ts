export namespace ToolTimeout {
  export type Source =
    | "execution_budget"
    | "search"
    | "fetch"
    | "download"
    | "wait"
    | "auto_background"
    | "question"
    | "vision"
    | "remote_connect"
    | "document_extract"

  export interface Metadata {
    executionBudgetMs: number
    operationTimeoutMs?: number
    displayMs: number
    source: Source
  }

  export const DEFAULTS = {
    globMs: 15_000,
    listMs: 15_000,
    scanFilesMs: 10_000,
    astGrepMs: 60_000,
    documentExtractMs: 60_000,
    webfetchMs: 30_000,
    webfetchMaxMs: 120_000,
    websearchMs: 25_000,
    arxivSearchMs: 30_000,
    arxivDownloadMs: 60_000,
    browserWaitMs: 10_000,
    browserWaitMaxMs: 60_000,
    browserDownloadMs: 120_000,
    browserDownloadsWaitMs: 30_000,
    browserHelperWaitMs: 30_000,
    browserLocatorMs: 5_000,
    connectMs: 30_000,
    taskAutoBackgroundMs: 300_000,
    taskOutputWaitMs: 300_000,
    processPollWaitMs: 30_000,
    questionMs: 1_800_000,
    lookAtMs: 120_000,
    bashHardCeilingMs: 3_600_000,
  } as const

  export function create(input: { executionBudgetMs: number; operationTimeoutMs?: number; source?: Source }): Metadata {
    const operationTimeoutMs = normalizeMs(input.operationTimeoutMs)
    return {
      executionBudgetMs: input.executionBudgetMs,
      ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
      displayMs: operationTimeoutMs ?? input.executionBudgetMs,
      source: operationTimeoutMs !== undefined ? (input.source ?? "wait") : "execution_budget",
    }
  }

  export function withOperation(
    base: Metadata | undefined,
    operationTimeoutMs: number | undefined,
    source: Source,
  ): Metadata | undefined {
    if (!base) return undefined
    return create({
      executionBudgetMs: base.executionBudgetMs,
      operationTimeoutMs,
      source,
    })
  }

  export function preserveMetadata(
    existing: Record<string, any> | undefined,
    next: Record<string, any> | undefined,
  ): Record<string, any> | undefined {
    if (!next) return existing
    if (!existing?.toolTimeout) return next
    if (next.toolTimeout !== undefined) return next
    return { ...next, toolTimeout: existing.toolTimeout }
  }

  export function metadataForTool(input: {
    tool: string
    args: Record<string, any>
    executionBudgetMs: number
    mcpCallTimeoutMs?: number
  }): Metadata {
    const operation = operationForTool(input.tool, input.args, input.mcpCallTimeoutMs)
    return create({
      executionBudgetMs: input.executionBudgetMs,
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
        return { timeoutMs: normalizeMinMs(args.timeoutMs, DEFAULTS.scanFilesMs, 1_000), source: "search" }
      case "ast_grep":
      case "parse_code":
        return { timeoutMs: DEFAULTS.astGrepMs, source: "search" }
      case "scan_document":
        return { timeoutMs: DEFAULTS.documentExtractMs, source: "document_extract" }
      case "webfetch":
        return {
          timeoutMs: Math.min(secondsToMs(args.timeout, DEFAULTS.webfetchMs), DEFAULTS.webfetchMaxMs),
          source: "fetch",
        }
      case "websearch":
        return { timeoutMs: DEFAULTS.websearchMs, source: "fetch" }
      case "arxiv_search":
        return { timeoutMs: DEFAULTS.arxivSearchMs, source: "fetch" }
      case "arxiv_download":
        return { timeoutMs: DEFAULTS.arxivDownloadMs, source: "download" }
      case "browser_wait":
        return {
          timeoutMs: clampMs(args.timeout, DEFAULTS.browserWaitMs, 500, DEFAULTS.browserWaitMaxMs),
          source: "wait",
        }
      case "browser_download":
        return { timeoutMs: DEFAULTS.browserDownloadMs, source: "download" }
      case "browser_downloads":
        if (args.action !== "wait") return undefined
        return {
          timeoutMs: normalizeMs(args.timeoutMs) ?? DEFAULTS.browserDownloadsWaitMs,
          source: "wait",
        }
      case "connect":
        if (args.action !== "open" && args.action !== "close") return undefined
        return { timeoutMs: DEFAULTS.connectMs, source: "remote_connect" }
      case "task":
        return { timeoutMs: DEFAULTS.taskAutoBackgroundMs, source: "auto_background" }
      case "task_output":
        if (!args.block) return undefined
        return { timeoutMs: secondsToMs(args.timeout, DEFAULTS.taskOutputWaitMs), source: "wait" }
      case "bash":
        if (typeof args.yieldSeconds === "number" && Number.isFinite(args.yieldSeconds) && args.yieldSeconds > 0) {
          return { timeoutMs: args.yieldSeconds * 1_000, source: "auto_background" }
        }
        return undefined
      case "process":
        if (args.action !== "poll" || !args.block) return undefined
        return { timeoutMs: secondsToMs(args.timeout, DEFAULTS.processPollWaitMs), source: "wait" }
      case "question":
        return { timeoutMs: DEFAULTS.questionMs, source: "question" }
      case "look_at":
        return { timeoutMs: secondsToMs(args.timeout, DEFAULTS.lookAtMs), source: "vision" }
      default:
        if (mcpCallTimeoutMs !== undefined) return { timeoutMs: mcpCallTimeoutMs, source: "wait" }
        return undefined
    }
  }

  function normalizeMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
    return value
  }

  function normalizeMinMs(value: unknown, fallbackMs: number, minMs: number): number {
    return Math.max(normalizeMs(value) ?? fallbackMs, minMs)
  }

  function secondsToMs(value: unknown, fallbackMs: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs
    return value * 1_000
  }

  function clampMs(value: unknown, fallbackMs: number, minMs: number, maxMs: number): number {
    const ms = normalizeMs(value) ?? fallbackMs
    return Math.min(Math.max(ms, minMs), maxMs)
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
