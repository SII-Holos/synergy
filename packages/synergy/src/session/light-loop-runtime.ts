import { Session } from "."
import { Plugin } from "../plugin"


const activeTimers = new Map<string, Timer>()

function timerKey(executionSessionID: string): string {
  return `lightloop_deadline:${executionSessionID}`
}

function setDeadlineTimer(executionSessionID: string, deadlineAt: number, onExpire: () => void) {
  clearDeadlineTimer(executionSessionID)
  const delayMs = Math.max(0, deadlineAt - Date.now())
  if (delayMs <= 0) {
    onExpire()
    return
  }
  const timer = setTimeout(onExpire, delayMs)
  timer.unref()
  activeTimers.set(timerKey(executionSessionID), timer)
}

function clearDeadlineTimer(executionSessionID: string) {
  const existing = activeTimers.get(timerKey(executionSessionID))
  if (existing) {
    clearTimeout(existing)
    activeTimers.delete(timerKey(executionSessionID))
  }
}

export namespace LightLoopRuntime {
  /**
   * Reattach deadline timers for all active plugin-owned LightLoops.
   * Called during runtime init/reload — sessions may have been loaded
   * from storage with deadlineAt set but no live timer.
   */
  export async function reattachPluginTimers(): Promise<void> {
    for await (const session of Session.listAll()) {
      const wf = session.workflow
      if (wf?.kind !== "lightloop") continue
      if (!wf.pluginOwner) continue
      if (!wf.deadlineAt) continue
      if (wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled" || wf.status === "timed_out" || wf.status === "iteration_exhausted") continue
      // Only reattach if there isn't already an active timer for this session
      if (activeTimers.has(timerKey(session.id))) continue
      scheduleDeadline(session.id, wf.deadlineAt)
    }
  }

  /**
   * Set terminal status on a LightLoop. Idempotent — a repeated call on
   * an already-terminal loop retries an undelivered hook without re-mutating
   * terminal status. Exact status remains completed/cancelled/timed_out/
   * iteration_exhausted/failed. Fires lightloop.after for plugin-owned
   * loops. Hook failure does not rollback terminal state.
   *
   * This is the SINGLE terminal path — approve, cancel, deadline timeout,
   * max-iteration exhaustion, and failure all use this method.
   */
  export async function setTerminalStatus(
    sessionID: string,
    status: "completed" | "failed" | "cancelled" | "timed_out" | "iteration_exhausted",
    error?: string,
  ): Promise<void> {
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lightloop") return

    const workflow = session.workflow
    const alreadyTerminal =
      workflow.status === "completed" ||
      workflow.status === "failed" ||
      workflow.status === "cancelled" ||
      workflow.status === "timed_out" ||
      workflow.status === "iteration_exhausted"

    if (!alreadyTerminal) {
      // Persist terminal status
      await Session.update(sessionID, (draft) => {
        if (draft.workflow?.kind !== "lightloop") return
        draft.workflow = {
          ...draft.workflow,
          status,
          terminalError: error ?? (status === "iteration_exhausted" ? "iteration_exhausted" : undefined),
        }
      })
    }

    clearDeadlineTimer(sessionID)

    // Refresh session after potential update
    const updated = alreadyTerminal ? workflow : (await Session.get(sessionID)).workflow
    if (!updated || updated.kind !== "lightloop" || !updated.pluginOwner) return

    // Fire lightloop.after observer for plugin-owned loops only.
    // Idempotent guard: terminalHookDeliveredAt prevents duplicate delivery.
    // If the hook was never delivered (terminalHookDeliveredAt is undefined),
    // retry even when already terminal.
    if (updated.terminalHookDeliveredAt === undefined) {
      const hookStatus =
        updated.status === "completed" ||
        updated.status === "cancelled" ||
        updated.status === "timed_out" ||
        updated.status === "iteration_exhausted" ||
        updated.status === "failed"
          ? updated.status
          : status

      const hookPayload = {
        loop: {
          sessionID,
          status: hookStatus,
          instructions: updated.instructions,
          ...(updated.terminalError ? { error: updated.terminalError } : {}),
        },
      }
      // Hook failure does NOT rollback terminal state
      const delivered = await Plugin.triggerForPlugin(
        updated.pluginOwner.pluginId,
        updated.pluginOwner.pluginGeneration,
        "lightloop.after",
        hookPayload,
        {},
      ).catch(() => undefined)

      if (delivered) {
        await Session.update(sessionID, (draft) => {
          if (draft.workflow?.kind !== "lightloop") return
          draft.workflow.terminalHookDeliveredAt = Date.now()
          draft.workflow.terminalHookError = undefined
        }).catch(() => {})
      } else {
        // Mark hook failure so the next retry can distinguish stale state
        await Session.update(sessionID, (draft) => {
          if (draft.workflow?.kind !== "lightloop") return
          draft.workflow.terminalHookError = "delivery_failed"
        }).catch(() => {})
      }
    }
  }

  export function scheduleDeadline(sessionID: string, deadlineAt: number) {
    setDeadlineTimer(sessionID, deadlineAt, async () => {
      try {
        await setTerminalStatus(sessionID, "timed_out", "deadline exceeded")
      } catch {
        // best effort
      }
    })
  }

  export function cancelDeadline(sessionID: string) {
    clearDeadlineTimer(sessionID)
  }
}
