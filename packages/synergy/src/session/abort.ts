import { SessionInvoke } from "./invoke"
type AbortHook = (sessionID: string) => void | Promise<void>

export namespace SessionAbort {
  const hooks = new Set<AbortHook>()

  export function registerHook(hook: AbortHook): () => void {
    hooks.add(hook)
    return () => hooks.delete(hook)
  }

  export async function abort(sessionID: string): Promise<void> {
    SessionInvoke.cancel(sessionID)
    const { Cortex } = await import("../cortex")
    await Cortex.cancelAll(sessionID)
    await SessionInvoke.repairAfterAbort(sessionID)
    await Promise.all([...hooks].map((hook) => hook(sessionID)))
  }
}
