import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { Vcs } from "./vcs"

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
}
