import { Lock } from "../util/lock"

export namespace SessionMutation {
  export function write(scopeID: string, sessionID: string) {
    return Lock.write(`session-mutation:${scopeID}:${sessionID}`)
  }
}
