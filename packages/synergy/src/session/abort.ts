import { SessionInvoke } from "./invoke"

export namespace SessionAbort {
  export async function abort(sessionID: string): Promise<void> {
    SessionInvoke.cancel(sessionID)
    const { Cortex } = await import("../cortex")
    await Cortex.cancelAll(sessionID)
    await SessionInvoke.repairAfterAbort(sessionID)
  }
}
