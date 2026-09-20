import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { Vcs } from "./vcs"
import { startWorktreeJanitor, stopWorktreeJanitor } from "./worktree-janitor"

/**
 * H5 project startup contribution: Vcs.init moves out of scope/runtime.ts.
 * It runs after the file watcher, matching the historical startup sequence.
 */
export function registerProjectStartup() {
  ScopeStartup.register({
    name: "vcs-init",
    before: ["command-watcher"],
    phase: "surface",
    after: ["file-watcher"],
    init: () => void Vcs.init(),
  })
  // The janitor only schedules itself here; its first scan is deferred with an
  // unref'd timer so neither startup latency nor process lifetime depends on it.
  ScopeStartup.register({
    name: "worktree-janitor",
    phase: "surface",
    after: ["vcs-init"],
    init: (scope) => startWorktreeJanitor(scope),
    dispose: (scopeID) => stopWorktreeJanitor(scopeID),
  })
}
