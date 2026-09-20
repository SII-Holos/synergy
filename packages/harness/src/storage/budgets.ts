import { ObservabilityConfig } from "../observability/config"

/**
 * Timing budgets shared by every path that can occupy the worker's single event
 * loop.
 *
 * The worker answers one statement at a time from one event loop, so a statement
 * that outlives a caller's patience also blocks that worker's liveness probe.
 * The probe timeout is therefore a *busy* signal rather than a death signal, and
 * `hardCeilingMs` is what finally decides that a worker is wedged.
 *
 * `chunkBudgetMs` is the per-chunk budget every maintenance, DDL, delete and
 * migration path must stay inside. `CEILING_MARGIN` is the invariant that keeps
 * a legitimate chunk from ever reaching the ceiling, so raising a chunk budget
 * cannot silently reopen the window that let one statement kill a runtime.
 *
 * `teardownBudgetMs` is deliberately not the ceiling, and deliberately not
 * configurable. The host that asks storage to close is itself on a deadline and
 * exits non-zero when cleanup outlasts it, skipping every step queued behind
 * storage — including terminal writes that settle only during shutdown. Waiting
 * out the ceiling would therefore outlive the process that requested the close,
 * so teardown gets one small fixed budget shared across its whole sequence.
 */
export namespace StorageBudgets {
  /** A legitimate chunk must finish this many times faster than the ceiling. */
  const CEILING_MARGIN = 4

  /**
   * Total budget for the entire teardown sequence.
   *
   * The runtime's shutdown window is the largest execution cancel grace plus a
   * settle margin — ten seconds with the shipped graces — and it exits non-zero
   * when cleanup outlasts it. Five seconds leaves room for the shutdown steps
   * that run after storage while still being orders of magnitude more than a
   * queue drain needs. It is not configurable because the only value a user could
   * usefully choose is one that fits inside a window the host already fixed.
   */
  const TEARDOWN_BUDGET_MS = 5_000

  export interface Timings {
    /** Budget for one ordinary statement. */
    requestDeadlineMs: number
    /** Budget for one liveness probe. */
    probeTimeoutMs: number
    /** Unanswered probes in a row before the worker is called occupied. */
    probeAttempts: number
    /** Sustained unresponsiveness after which the worker is a terminal wedge. */
    hardCeilingMs: number
    /** Budget for one maintenance, DDL, delete or migration chunk. */
    chunkBudgetMs: number
    /** Total budget for the whole teardown sequence, shared across its steps. */
    teardownBudgetMs: number
  }

  let cachedSource: unknown
  let cachedTimings: Timings | undefined

  export function current(): Timings {
    // `ObservabilityConfig.current()` hands back one object until it is
    // refreshed, so identity is a valid cache key on this hot path.
    const storage = ObservabilityConfig.current().storage
    if (cachedSource === storage && cachedTimings) return cachedTimings
    cachedSource = storage
    cachedTimings = resolve(storage)
    return cachedTimings
  }

  function resolve(storage: {
    requestDeadlineMs: number
    probeTimeoutMs: number
    probeAttempts: number
    hardCeilingMs: number
    chunkBudgetMs: number
  }): Timings {
    const hardCeilingMs = Math.max(1_000, storage.hardCeilingMs)
    return {
      requestDeadlineMs: Math.max(1, storage.requestDeadlineMs),
      probeTimeoutMs: Math.max(1, storage.probeTimeoutMs),
      probeAttempts: Math.max(1, storage.probeAttempts),
      hardCeilingMs,
      // Clamped rather than rejected: a configuration that would reopen the
      // terminal window must simply not take effect.
      chunkBudgetMs: Math.min(Math.max(1, storage.chunkBudgetMs), Math.floor(hardCeilingMs / CEILING_MARGIN)),
      // Never allowed to grow past the margin, so a ceiling raised to cover a
      // long legitimate statement cannot also stretch teardown.
      teardownBudgetMs: Math.min(TEARDOWN_BUDGET_MS, Math.floor(hardCeilingMs / CEILING_MARGIN)),
    }
  }

  /** The safety margin the chunk budget must leave below the hard ceiling. */
  export function ceilingMargin() {
    return CEILING_MARGIN
  }
}
