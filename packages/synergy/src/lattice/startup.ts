import { ScopeStartup } from "../scope/startup"
import { LatticeRuntime } from "./runtime"

/**
 * H5 lattice startup contribution: LatticeRuntime.init moves out of
 * scope/runtime.ts. Order-sensitive (blueprint): it must run after session
 * recovery reconciles runtime state and before activity summary and pending
 * session resume, matching the historical startup sequence.
 */
export function registerLatticeStartup() {
  ScopeStartup.register({
    name: "lattice-runtime",
    phase: "workflow",
    after: ["session-recovery"],
    before: ["activity-summary", "resume-pending"],
    init: () => LatticeRuntime.init(),
  })
}
