import { SessionInvoke } from "./invoke"
import { SessionCortexRuntime } from "./cortex-runtime"
type AbortHook = (sessionID: string) => void | Promise<void>

export namespace SessionAbort {
  const hooks = new Set<AbortHook>()

  export function registerHook(hook: AbortHook): () => void {
    hooks.add(hook)
    return () => hooks.delete(hook)
  }

  export async function abort(sessionID: string, options?: { recoverQueuedTasks?: boolean }): Promise<void> {
    SessionInvoke.cancel(sessionID, options)
    await SessionCortexRuntime.cancelAllForParent(sessionID)
    await SessionInvoke.repairAfterAbort(sessionID)
    await Promise.all([...hooks].map((hook) => hook(sessionID)))
  }
}
