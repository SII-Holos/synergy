import { Lock } from "@ericsanchezok/synergy-harness/util/lock"

export namespace LatticeLock {
  export function write(scopeID: string, sessionID: string) {
    return Lock.write(`lattice-controller:${scopeID}:${sessionID}`)
  }
}
