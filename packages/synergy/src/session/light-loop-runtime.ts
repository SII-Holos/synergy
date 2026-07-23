import { Session } from "."
import { Plugin } from "../plugin"
import { Lock } from "../util/lock"
import { isLightLoopTerminalStatus, type LightLoopTerminalStatus } from "./light-loop-state"

const activeTimers = new Map<string, Timer>()

function timerKey(executionSessionID: string): string {
  return `lightloop_deadline:${executionSessionID}`
}

function terminalHookLock(executionSessionID: string): string {
  return `lightloop_terminal_hook:${executionSessionID}`
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
   * Reattach active deadlines and retry unacknowledged terminal hooks.
   * Called during runtime init/reload after sessions are loaded from storage.
   */
  export async function reattachPluginTimers(): Promise<void> {
    for await (const session of Session.listAll()) {
      const workflow = session.workflow
      if (workflow?.kind !== "lightloop" || !workflow.pluginOwner) continue
      if (isLightLoopTerminalStatus(workflow.status)) {
        if (workflow.terminalHookDeliveredAt === undefined) {
          await setTerminalStatus(session.id, workflow.status, workflow.terminalError).catch(() => undefined)
        }
        continue
      }
      if (!workflow.deadlineAt) continue
      if (activeTimers.has(timerKey(session.id))) continue
      scheduleDeadline(session.id, workflow.deadlineAt)
    }
  }

  /**
   * Ordinary Light Loops exit by clearing the workflow. Plugin-owned loops
   * retain terminal state so an unacknowledged lightloop.after hook can retry.
   *
   * This is the SINGLE terminal path — approve, cancel, deadline timeout,
   * max-iteration exhaustion, and failure all use this method.
   */
  export async function setTerminalStatus(
    sessionID: string,
    status: LightLoopTerminalStatus,
    error?: string,
  ): Promise<void> {
    using _ = await Lock.write(terminalHookLock(sessionID))
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lightloop") return

    if (!session.workflow.pluginOwner) {
      await Session.update(sessionID, (draft) => {
        if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
      })
      clearDeadlineTimer(sessionID)
      return
    }

    if (!isLightLoopTerminalStatus(session.workflow.status)) {
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

    const updated = (await Session.get(sessionID)).workflow
    if (updated?.kind !== "lightloop" || !updated.pluginOwner || updated.terminalHookDeliveredAt !== undefined) return

    const hookStatus = isLightLoopTerminalStatus(updated.status) ? updated.status : status
    const hookPayload = {
      loop: {
        sessionID,
        status: hookStatus,
        instructions: updated.instructions,
        ...(updated.terminalError ? { error: updated.terminalError } : {}),
      },
    }
    const delivery = await Plugin.deliverHookForPlugin(
      updated.pluginOwner.pluginId,
      updated.pluginOwner.pluginGeneration,
      "lightloop.after",
      hookPayload,
    ).catch((hookError) => ({
      status: "failed" as const,
      handlerCount: 0,
      succeededHandlerCount: 0,
      error: `Hook lightloop.after delivery failed: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
    }))

    await Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop" || draft.workflow.terminalHookDeliveredAt !== undefined) return
      if (delivery.status === "delivered") {
        if (delivery.handlerCount > 0) {
          draft.workflow.terminalHookDeliveredAt = Date.now()
          draft.workflow.terminalHookError = undefined
          return
        }
        draft.workflow.terminalHookError = "Hook lightloop.after reported delivery without a handler"
        return
      }
      draft.workflow.terminalHookError = delivery.error
    })
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
