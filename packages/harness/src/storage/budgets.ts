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
 * `chunkBudgetMs` is the budget for the one maintenance operation that can be
 * split, `reclaim`: it frees a bounded page count per call, so a fixed budget is
 * enforceable. `CEILING_MARGIN` is the invariant that keeps that budget from
 * ever reaching the ceiling, so raising it cannot silently reopen the window
 * that let one statement kill a runtime.
 *
 * `engineBudgetMs` is for the statements that cannot be split at all: SQLite has
 * no partial `CREATE INDEX`, `PRAGMA integrity_check` is one engine call, and
 * `VACUUM` rewrites every page. Those grow with store size, so measuring them
 * against a chunk budget would fail a statement that is merely large -- and an
 * index build that is failed at its deadline is rolled back and rebuilt on every
 * open. They are budgeted by the ceiling itself, which is what the ceiling
 * exists to bound.
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
    /** Budget for one splittable maintenance chunk, which is only `reclaim`. */
    chunkBudgetMs: number
    /**
     * Budget for a statement that cannot be chunked, which is the ceiling
     * itself: these grow with the store, so anything smaller would fail a
     * statement that is merely large.
     */
    engineBudgetMs: number
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
      // Every budget that can occupy the loop is clamped, not just the chunk
      // budget: the invariant only protects the worker if it holds for *every*
      // allowed single-statement limit, so a configuration that would let one
      // ordinary statement outlive the ceiling must not take effect either.
      requestDeadlineMs: Math.min(Math.max(1, storage.requestDeadlineMs), Math.floor(hardCeilingMs / CEILING_MARGIN)),
      probeTimeoutMs: Math.min(Math.max(1, storage.probeTimeoutMs), Math.floor(hardCeilingMs / CEILING_MARGIN)),
      probeAttempts: Math.max(1, storage.probeAttempts),
      hardCeilingMs,
      chunkBudgetMs: Math.min(Math.max(1, storage.chunkBudgetMs), Math.floor(hardCeilingMs / CEILING_MARGIN)),
      engineBudgetMs: hardCeilingMs,
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
