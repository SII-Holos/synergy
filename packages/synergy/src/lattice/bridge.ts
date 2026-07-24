import { LatticeRuntime } from "./runtime"

/** Existing SessionInvoke seam; the scoped Runtime is idempotent. */
export namespace LatticeBridge {
  export function init(): void {
    LatticeRuntime.ensure()
  }
}
