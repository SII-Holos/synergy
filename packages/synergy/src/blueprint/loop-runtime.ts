import { BlueprintLoopStore, isActiveLoopStatus } from "./loop-store"
import { NoteStore } from "../note"
import { Session } from "../session"
import { Cortex } from "../cortex"

const activeTimers = new Map<string, Timer>()

function timerKey(scopeID: string, loopID: string): string {
  return `blueprint_deadline:${scopeID}:${loopID}`
}

function clearTimer(scopeID: string, loopID: string) {
  const existing = activeTimers.get(timerKey(scopeID, loopID))
  if (existing) {
    clearTimeout(existing)
    activeTimers.delete(timerKey(scopeID, loopID))
  }
}

function setDeadlineTimer(scopeID: string, loopID: string, maxRuntimeMs: number, onExpire: () => void) {
  clearTimer(scopeID, loopID)
  const timer = setTimeout(onExpire, maxRuntimeMs)
  timer.unref()
  activeTimers.set(timerKey(scopeID, loopID), timer)
}

export namespace BlueprintLoopRuntime {
  /**
   * Reattach deadline timers for all active plugin-owned BlueprintLoops.
   * Called during plugin init/reload — uses the current scope (best-effort).
   */
  export async function reattachPluginTimers(): Promise<void> {
    try {
      const { ScopeContext } = await import("../scope/context")
      const scopeID = ScopeContext.current.scope.id
      const loops = await BlueprintLoopStore.list(scopeID).catch(() => [])
      for (const loop of loops) {
        if (!loop.budget?.maxRuntimeMs) continue
        if (loop.source !== "plugin" || !loop.pluginOwner) continue
        if (!isActiveLoopStatus(loop.status)) continue
        if (loop.status === "armed") continue // not yet started
        if (activeTimers.has(timerKey(scopeID, loop.id))) continue
        const elapsed = Date.now() - loop.time.created
        const remaining = Math.max(0, loop.budget.maxRuntimeMs - elapsed)
        if (remaining <= 0) {
          void expireLoop(scopeID, loop.id).catch(() => {})
          continue
        }
        scheduleDeadline(scopeID, loop.id, remaining)
      }
    } catch {
      // best effort
    }
  }

  export function scheduleDeadline(scopeID: string, loopID: string, maxRuntimeMs: number) {
    setDeadlineTimer(scopeID, loopID, maxRuntimeMs, async () => {
      try {
        await expireLoop(scopeID, loopID)
      } catch {
        // best effort
      }
    })
  }

  export function cancelDeadline(scopeID: string, loopID: string) {
    clearTimer(scopeID, loopID)
  }
}

async function expireLoop(scopeID: string, loopID: string): Promise<void> {
  const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
  if (!loop) return
  if (!isActiveLoopStatus(loop.status)) return

  // Cancel execution task
  if (loop.sessionID) {
    const execSession = await Session.get(loop.sessionID).catch(() => undefined)
    if (execSession?.cortex?.taskID) {
      await Cortex.cancel(execSession.cortex.taskID).catch(() => {})
    }
  }
  // Cancel audit task
  if (loop.auditSessionID) {
    const auditSession = await Session.get(loop.auditSessionID).catch(() => undefined)
    if (auditSession?.cortex?.taskID) {
      await Cortex.cancel(auditSession.cortex.taskID).catch(() => {})
    }
  }

  // Terminalize as failed with timed_out
  await BlueprintLoopStore.updateStatus(scopeID, loopID, {
    status: "failed",
    error: "timed_out: budget maxRuntimeMs exceeded",
  })

  // Archive generated resources only for plugin-owned loops
  if (loop.noteID && loop.source === "plugin") {
    await NoteStore.update(scopeID, loop.noteID, { archived: true }).catch(() => {})
  }
  if (loop.sessionID && loop.source === "plugin") {
    await Session.update(loop.sessionID, (draft) => {
      draft.time.archived = Date.now()
    }).catch(() => {})
  }
}
