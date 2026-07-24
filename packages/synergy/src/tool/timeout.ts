export namespace ToolTimeout {
  export type Source =
    | "tool_timeout"
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
    toolTimeoutMs: number
    operationTimeoutMs?: number
    displayMs: number
    source: Source
  }

  export interface ExecutionDeadline {
    signal: AbortSignal
    run<T>(operation: Promise<T>): Promise<T>
    dispose(): void
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

  export function create(input: { toolTimeoutMs: number; operationTimeoutMs?: number; source?: Source }): Metadata {
    const operationTimeoutMs = normalizeMs(input.operationTimeoutMs)
    return {
      toolTimeoutMs: input.toolTimeoutMs,
      ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
      displayMs: operationTimeoutMs ?? input.toolTimeoutMs,
      source: operationTimeoutMs !== undefined ? (input.source ?? "wait") : "tool_timeout",
    }
  }

  export function executionDeadline(input: {
    signal: AbortSignal
    timeoutMs: number
    label?: string
  }): ExecutionDeadline {
    const timeout = new AbortController()
    const signal = AbortSignal.any([input.signal, timeout.signal])
    const timer = setTimeout(() => {
      timeout.abort(
        new DOMException(`${input.label ?? "Tool execution"} timed out after ${input.timeoutMs}ms.`, "TimeoutError"),
      )
    }, input.timeoutMs)
    if (typeof timer === "object" && "unref" in timer) timer.unref()

    let disposed = false
    return {
      signal,
      run<T>(operation: Promise<T>) {
        if (signal.aborted) {
          return Promise.reject(signal.reason ?? new DOMException("Tool execution aborted.", "AbortError"))
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            reject(signal.reason ?? new DOMException("Tool execution aborted.", "AbortError"))
          }
          signal.addEventListener("abort", onAbort, { once: true })
          operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
        })
      },
      dispose() {
        if (disposed) return
        disposed = true
        clearTimeout(timer)
      },
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
      case "bash": {
        const commandTimeoutMs = secondsToMsOrUndefined(args.timeoutSeconds)
        const effectiveAutoBackgroundMs =
          secondsToMsOrUndefined(args.backgroundAfterSeconds) ?? DEFAULTS.bashAutoBackgroundMs
        if (effectiveAutoBackgroundMs && commandTimeoutMs && commandTimeoutMs < effectiveAutoBackgroundMs) {
          return { timeoutMs: commandTimeoutMs, source: "wait" }
        }
        if (effectiveAutoBackgroundMs) {
          return { timeoutMs: effectiveAutoBackgroundMs, source: "auto_background" }
        }
        return commandTimeoutMs ? { timeoutMs: commandTimeoutMs, source: "wait" } : undefined
      }
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

  function secondsToMsOrUndefined(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
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
