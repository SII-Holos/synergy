import type { SynergyClient } from "@ericsanchezok/synergy-sdk"

/**
 * Terminal statuses for a Light Loop workflow. The CLI treats any of these as
 * the end of a benchmark attempt; approval clears the workflow entirely.
 */
export const LIGHT_LOOP_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "iteration_exhausted",
] as const

export type LightLoopTerminalStatus = (typeof LIGHT_LOOP_TERMINAL_STATUSES)[number]

export function isTerminalLightLoopStatus(status: unknown): status is LightLoopTerminalStatus {
  return typeof status === "string" && (LIGHT_LOOP_TERMINAL_STATUSES as readonly string[]).includes(status)
}

export interface LightLoopFinished {
  finished: boolean
  status: LightLoopTerminalStatus | undefined
}

/**
 * Decide whether a Light Loop attempt has ended. The benchmark adapter runs
 * Synergy as one attempt per task container, so an attempt is over when the
 * workflow reaches a terminal status or is cleared (approval clears it).
 */
export function isLightLoopFinished(session: {
  workflow?: { kind?: string; status?: unknown; instructions?: string }
}): LightLoopFinished {
  const workflow = session.workflow
  if (!workflow) return { finished: true, status: undefined }
  if (workflow.kind !== "lightloop") return { finished: false, status: undefined }
  if (isTerminalLightLoopStatus(workflow.status)) {
    return { finished: true, status: workflow.status }
  }
  return { finished: false, status: undefined }
}

export interface LightLoopWaitOptions {
  /** Poll interval in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number
  /** Hard timeout in milliseconds. Defaults to 6 hours. */
  timeoutMs?: number
  /** Abort signal to stop waiting early. */
  signal?: AbortSignal
}

export interface LightLoopWaitResult {
  status: LightLoopTerminalStatus | undefined
  elapsedMs: number
  timedOut: boolean
}

/**
 * Wait for a Light Loop attempt to finish by polling the session workflow.
 *
 * The CLI cannot rely on `session.idle` alone: the parent session goes idle
 * while the reviewer runs, and a rejected review resumes the executor. The
 * authoritative end-of-attempt signal is the workflow status (terminal status,
 * or cleared after approval).
 */
export async function waitForLightLoopFinish(
  sdk: SynergyClient,
  sessionID: string,
  options: LightLoopWaitOptions = {},
): Promise<LightLoopWaitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000
  const startedAt = Date.now()

  for (;;) {
    if (options.signal?.aborted) {
      return { status: undefined, elapsedMs: Date.now() - startedAt, timedOut: false }
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= timeoutMs) {
      return { status: undefined, elapsedMs, timedOut: true }
    }

    const result = await sdk.session.get({ sessionID })
    if (result.error) {
      throw new Error(errorMessage(result.error) ?? `Failed to read session: ${sessionID}`)
    }
    const finished = isLightLoopFinished(result.data ?? {})
    if (finished.finished) {
      return { status: finished.status, elapsedMs: Date.now() - startedAt, timedOut: false }
    }

    await sleep(pollIntervalMs)
  }
}

function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = error.data
  if (!data || typeof data !== "object" || !("message" in data)) return undefined
  return typeof data.message === "string" ? data.message : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
