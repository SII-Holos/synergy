import { Session } from "."
import { Plugin } from "../plugin"
import { Lock } from "../util/lock"
import { isLightLoopTerminalStatus, type LightLoopTerminalStatus } from "./light-loop-state"
import { LightLoopTerminalStore, type LightLoopTerminalRecord } from "./light-loop-terminal-hook"

const activeTimers = new Map<string, Timer>()

function timerKey(executionSessionID: string): string {
  return `lightloop_deadline:${executionSessionID}`
}

function terminalHookLock(executionSessionID: string): string {
  return `lightloop_terminal_hook:${executionSessionID}`
}

function samePluginOwner(
  a: NonNullable<LightLoopTerminalRecord["pluginOwner"]>,
  b: NonNullable<LightLoopTerminalRecord["pluginOwner"]>,
) {
  return (
    a.pluginId === b.pluginId &&
    a.pluginGeneration === b.pluginGeneration &&
    a.scopeId === b.scopeId &&
    a.correlationId === b.correlationId
  )
}

async function deliverTerminalHook(session: Awaited<ReturnType<typeof Session.get>>, record: LightLoopTerminalRecord) {
  if (record.hookDeliveredAt !== undefined) return
  if (!record.pluginOwner) {
    // Ordinary (non-plugin) loops have no lightloop.after hook. The record
    // exists so headless drivers can read the authoritative terminal status
    // after the workflow is cleared; acknowledge it directly.
    await LightLoopTerminalStore.acknowledge(session)
    return
  }
  const delivery = await Plugin.deliverHookForPlugin(
    record.pluginOwner.pluginId,
    record.pluginOwner.pluginGeneration,
    "lightloop.after",
    {
      loop: {
        sessionID: record.sessionID,
        status: record.status,
        instructions: record.instructions,
        ...(record.error ? { error: record.error } : {}),
      },
    },
  ).catch((hookError) => ({
    status: "failed" as const,
    handlerCount: 0,
    succeededHandlerCount: 0,
    error: `Hook lightloop.after delivery failed: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
  }))

  if (delivery.status === "delivered" && delivery.handlerCount > 0) {
    await LightLoopTerminalStore.acknowledge(session)
    return
  }
  const hookError =
    delivery.status === "delivered" ? "Hook lightloop.after reported delivery without a handler" : delivery.error
  await LightLoopTerminalStore.recordHookError(session, hookError)
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
      const terminal = await LightLoopTerminalStore.get(session)
      if (terminal) {
        const workflow = session.workflow
        if (
          workflow?.kind === "lightloop" &&
          workflow.pluginOwner &&
          terminal.pluginOwner &&
          samePluginOwner(workflow.pluginOwner, terminal.pluginOwner)
        ) {
          await Session.update(session.id, (draft) => {
            if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
          })
          clearDeadlineTimer(session.id)
        }
        await deliverTerminalHook(session, terminal).catch(() => undefined)
        continue
      }

      const workflow = session.workflow
      if (workflow?.kind === "lightloop" && workflow.pluginOwner && isLightLoopTerminalStatus(workflow.status)) {
        await setTerminalStatus(session.id, workflow.status, workflow.terminalError).catch(() => undefined)
        continue
      }

      if (workflow?.kind !== "lightloop" || !workflow.pluginOwner || !workflow.deadlineAt) continue
      if (activeTimers.has(timerKey(session.id))) continue
      scheduleDeadline(session.id, workflow.deadlineAt)
    }
  }

  /**
   * Terminal Light Loops always exit by clearing the interactive workflow.
   * Plugin-owned loops first persist a separate terminal record so their
   * lightloop.after hook and terminal query remain durable after unequip.
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
    const existing = await LightLoopTerminalStore.get(session)
    if (existing) {
      const workflow = session.workflow
      const activeLoop = workflow?.kind === "lightloop" && !isLightLoopTerminalStatus(workflow.status)
      const matchesPlugin =
        activeLoop &&
        workflow.pluginOwner !== undefined &&
        existing.pluginOwner !== undefined &&
        samePluginOwner(workflow.pluginOwner, existing.pluginOwner)
      if (matchesPlugin) {
        // Plugin-owned retry: the same loop ended again; clear the workflow and
        // retry the pending terminal hook.
        await Session.update(sessionID, (draft) => {
          if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
        })
        clearDeadlineTimer(sessionID)
        await deliverTerminalHook(session, existing)
        return
      }
      if (!activeLoop || existing.pluginOwner !== undefined) {
        // Idempotent re-entry (same terminal state) or a stale plugin record
        // with no matching active loop: preserve the existing record and retry
        // its hook delivery instead of replacing it.
        await deliverTerminalHook(session, existing)
        return
      }
      // A new ordinary loop started on the same session: the old terminal
      // record no longer describes this session's loop, so fall through and
      // replace it with the fresh terminal state.
    }
    if (session.workflow?.kind !== "lightloop") return

    const workflow = session.workflow
    const terminal = {
      sessionID,
      status: isLightLoopTerminalStatus(workflow.status) ? workflow.status : status,
      instructions: workflow.instructions,
      ...(workflow.pluginOwner ? { pluginOwner: workflow.pluginOwner } : {}),
      ...(workflow.terminalError || error
        ? { error: workflow.terminalError ?? error }
        : status === "iteration_exhausted"
          ? { error: "iteration_exhausted" }
          : {}),
      ...(workflow.terminalHookDeliveredAt ? { hookDeliveredAt: workflow.terminalHookDeliveredAt } : {}),
      ...(workflow.terminalHookError ? { hookError: workflow.terminalHookError } : {}),
      createdAt: Date.now(),
    } satisfies LightLoopTerminalRecord
    await LightLoopTerminalStore.put(session, terminal)

    await Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
    })
    clearDeadlineTimer(sessionID)
    await deliverTerminalHook(session, terminal)
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
