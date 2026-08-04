import type { SynergyClient } from "@ericsanchezok/synergy-sdk"

/**
 * Terminal statuses for a Light Loop workflow. The CLI treats any of these as
 * the end of a benchmark attempt.
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
  /**
   * True when the session no longer carries the Light Loop workflow because a
   * different workflow (plan/lattice) replaced it. The attempt no longer owns
   * the workflow and must terminate instead of waiting for a six-hour timeout.
   */
  replaced: boolean
}

/**
 * Decide whether a Light Loop attempt has ended.
 *
 * Terminal Light Loops clear the interactive workflow on every terminal path
 * (approval, exhaustion, timeout, cancellation, failure), so the absence of a
 * workflow means the attempt ended; the authoritative status then comes from
 * the durable terminal record. A different workflow replacing the Light Loop
 * also ends the attempt (mutually exclusive workflows mean this command no
 * longer owns it).
 */
export function isLightLoopFinished(
  session: { workflow?: { kind?: string; status?: unknown } },
  terminal?: { status?: LightLoopTerminalStatus } | undefined,
): LightLoopFinished {
  const workflow = session.workflow
  if (workflow?.kind === "lightloop") {
    if (isTerminalLightLoopStatus(workflow.status)) {
      return { finished: true, status: workflow.status, replaced: false }
    }
    return { finished: false, status: undefined, replaced: false }
  }
  if (!workflow) {
    return {
      finished: true,
      status: terminal?.status,
      replaced: false,
    }
  }
  return { finished: true, status: undefined, replaced: true }
}

export interface LightLoopWaitOptions {
  /** Poll interval in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number
  /** Hard timeout in milliseconds. Defaults to 6 hours. */
  timeoutMs?: number
  /** Wall-clock start for the hard timeout. Defaults to now. */
  startedAt?: number
  /** Abort signal to stop waiting early (e.g. a session error was observed). */
  signal?: AbortSignal
}

export interface LightLoopWaitResult {
  status: LightLoopTerminalStatus | undefined
  elapsedMs: number
  timedOut: boolean
  /** True when waiting stopped because the abort signal fired. */
  aborted: boolean
  /** True when the Light Loop was replaced by another workflow. */
  replaced: boolean
  /**
   * True when the workflow was cleared without a durable terminal record.
   * This happens when another workflow (or an explicit workflow reset)
   * evicted the Light Loop, so the attempt was interrupted rather than
   * completed. Callers must not treat this as success.
   */
  clearedWithoutRecord: boolean
}

/**
 * Wait for a Light Loop attempt to finish.
 *
 * The CLI cannot rely on `session.idle` alone: the parent session goes idle
 * while the reviewer runs, and a rejected review resumes the executor. The
 * end-of-attempt signal is the workflow state (terminal status, cleared after
 * approval, or replaced by another workflow). When the workflow is cleared,
 * the authoritative status is read from the durable terminal record so failed,
 * exhausted, timed-out, and cancelled attempts are distinguishable from
 * approval.
 */
export async function waitForLightLoopFinish(
  sdk: SynergyClient,
  sessionID: string,
  options: LightLoopWaitOptions = {},
): Promise<LightLoopWaitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000
  const startedAt = options.startedAt ?? Date.now()
  const deadline = startedAt + timeoutMs

  for (;;) {
    if (options.signal?.aborted) {
      return {
        status: undefined,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        aborted: true,
        replaced: false,
        clearedWithoutRecord: false,
      }
    }
    const elapsedMs = Date.now() - startedAt
    if (Date.now() >= deadline) {
      return {
        status: undefined,
        elapsedMs,
        timedOut: true,
        aborted: false,
        replaced: false,
        clearedWithoutRecord: false,
      }
    }

    const result = await sdk.session.get({ sessionID })
    if (result.error) {
      throw new Error(errorMessage(result.error) ?? `Failed to read session: ${sessionID}`)
    }
    const finished = isLightLoopFinished(result.data ?? {})
    if (finished.finished) {
      let status = finished.status
      let clearedWithoutRecord = false
      if (status === undefined && !finished.replaced) {
        // The workflow was cleared; read the authoritative terminal record.
        const terminal = await sdk.workflow.session.getLightloopTerminal({ id: sessionID }).catch(() => undefined)
        if (terminal && !terminal.error && terminal.data?.status) {
          status = terminal.data.status
        } else {
          // No durable terminal record exists: the Light Loop was evicted by
          // an external workflow reset rather than a terminal path. The
          // attempt was interrupted, not completed.
          clearedWithoutRecord = true
        }
      }
      return {
        status,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        aborted: false,
        replaced: finished.replaced,
        clearedWithoutRecord,
      }
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
