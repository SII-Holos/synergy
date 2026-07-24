import { Lock } from "../util/lock"

export namespace LatticeLock {
  export function write(scopeID: string, sessionID: string) {
    return Lock.write(`lattice-controller:${scopeID}:${sessionID}`)
  }
}
