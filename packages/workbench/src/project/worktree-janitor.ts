import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { readWorktreeConfig } from "@ericsanchezok/synergy-runtime-local/config-schema"
import { Worktree } from "@ericsanchezok/synergy-runtime-local/workspace/worktree"

const log = Log.create({ service: "worktree-janitor" })

const DEFAULT_SWEEP_INTERVAL_HOURS = 6

interface Schedule {
  first: ReturnType<typeof setTimeout>
  interval: ReturnType<typeof setInterval>
}

const schedules = new Map<string, Schedule>()
const sweeping = new Set<string>()
const rerunRequested = new Set<string>()

/**
 * Background reaper for managed git worktrees.
 *
 * The first scan is scheduled with `setTimeout(0)` rather than awaited, so a
 * slow or failing sweep never delays scope startup. Both timers are unref'd: a
 * janitor must not be the reason the process stays alive. Sweeps are mutually
 * exclusive per scope, because a tick that outlives its interval would
 * otherwise let two sweeps race on the same worktree.
 */
export async function startWorktreeJanitor(scope: Scope.Project) {
  // The cap owner asks for a sweep after each creation; routing that request back
  // here keeps one implementation of the timing, config, and mutual exclusion.
  Worktree.setSweepRequester(requestScopeSweep)
  if (scope.vcs !== "git" || schedules.has(scope.id)) return
  const config = await readWorktreeConfig().catch(() => undefined)
  if (config?.janitor === false) {
    log.info("worktree janitor disabled by config", { scopeID: scope.id })
    return
  }
  const intervalMs = (config?.sweepIntervalHours ?? DEFAULT_SWEEP_INTERVAL_HOURS) * 60 * 60 * 1000
  const trigger = () => void sweep(scope)
  const first = setTimeout(trigger, 0)
  first.unref()
  const interval = setInterval(trigger, intervalMs)
  interval.unref()
  schedules.set(scope.id, { first, interval })
  log.info("worktree janitor scheduled", { scopeID: scope.id, intervalMs })
}

export function stopWorktreeJanitor(scopeID: string) {
  const schedule = schedules.get(scopeID)
  if (!schedule) return
  clearTimeout(schedule.first)
  clearInterval(schedule.interval)
  schedules.delete(scopeID)
  sweeping.delete(scopeID)
  rerunRequested.delete(scopeID)
}

/**
 * Schedule a cap sweep for a scope without awaiting it.
 *
 * Called after a worktree is created, which is when the cap is most likely to be
 * exceeded. It must never throw or block: creation has already succeeded, so a
 * sweep that cannot converge must not surface as a creation failure. If a sweep
 * is already running, one follow-up is queued rather than dropped — the running
 * sweep may have read its inventory before this worktree existed.
 */
export function requestScopeSweep(scope: Scope.Project) {
  // Only a scope whose janitor actually started may sweep. The requester is
  // installed process-wide by the first scope that starts one, so without this
  // guard a creation in any other scope would run a background sweep it never
  // opted into — cancelling registrations that scope is still using.
  if (scope.vcs !== "git" || !schedules.has(scope.id)) return
  if (sweeping.has(scope.id)) {
    rerunRequested.add(scope.id)
    return
  }
  void sweep(scope)
}

async function sweep(scope: Scope.Project) {
  if (sweeping.has(scope.id)) return
  sweeping.add(scope.id)
  try {
    // Resolved per sweep so a config reload takes effect without a restart, and
    // so a read failure falls back to the cap default rather than skipping.
    const config = await readWorktreeConfig().catch(() => undefined)
    if (config?.janitor === false) return
    const report = await ScopeContext.provide({ scope, fn: () => Worktree.sweep({ maxManaged: config?.maxManaged }) })
    // Reasons are reported rather than swallowed: a cap that cannot converge is
    // the signal that worktrees are blocked on unpushed work, not a silent
    // pile-up.
    const blocked = report.skipped.map((item) => `${item.name}:${item.reason}`).join(", ")
    log.info("worktree sweep complete", {
      scopeID: scope.id,
      scanned: report.scanned,
      maxManaged: report.maxManaged,
      removed: report.removed.length,
      reconciled: report.reconciled.length,
      blocked: blocked || "none",
    })
  } catch (error) {
    log.warn("worktree sweep failed", { scopeID: scope.id, error })
  } finally {
    sweeping.delete(scope.id)
    if (rerunRequested.delete(scope.id)) void sweep(scope)
  }
}
