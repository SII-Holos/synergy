import { Session } from "../session"
import { Lock } from "../util/lock"
import {
  isActiveLightLoopWorkflow,
  isLightLoopTerminalStatus,
  type LightLoopTerminalStatus,
} from "../session/light-loop-state"
import { LightLoopTerminalStore, type LightLoopTerminalRecord } from "./terminal-hook"

/** Structural shape of the plugin hook-delivery result the terminal path
 * consumes; the concrete implementation is injected from the L4 product
 * manifest so the light-loop domain does not import the plugin domain. */
export interface TerminalHookDeliveryResult {
  status: "delivered" | "plugin_mismatch" | "no_handler" | "failed"
  handlerCount: number
  succeededHandlerCount?: number
  error?: string
}

export type TerminalHookDeliverer = (
  pluginId: string,
  pluginGeneration: string,
  pointName: string,
  input: unknown,
) => Promise<TerminalHookDeliveryResult>

let terminalHookDeliverer: TerminalHookDeliverer | undefined

/** L4 product registration injects Plugin.deliverHookForPlugin here; without
 * it, plugin-owned terminal hooks record a durable delivery error instead of
 * silently vanishing. */
export function setTerminalHookDeliverer(deliverer: TerminalHookDeliverer): void {
  terminalHookDeliverer = deliverer
}

function errorText(error: unknown): string {
  if (!error) return "Light Loop execution failed"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (typeof error === "object") {
    const obj = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof obj.data?.message === "string" && obj.data.message) return obj.data.message
    if (typeof obj.message === "string" && obj.message) return obj.message
  }
  return "Light Loop execution failed"
}

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
  if (!terminalHookDeliverer) {
    await LightLoopTerminalStore.recordHookError(
      session,
      "Hook lightloop.after delivery unavailable: plugin registration not loaded",
    )
    return
  }
  const delivery = await terminalHookDeliverer(
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
  ).catch((hookError: unknown) => ({
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
    delivery.status === "delivered"
      ? "Hook lightloop.after reported delivery without a handler"
      : (delivery.error ?? "Hook lightloop.after delivery failed")
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
      if (
        activeLoop &&
        workflow.pluginOwner !== undefined &&
        existing.pluginOwner !== undefined &&
        samePluginOwner(workflow.pluginOwner, existing.pluginOwner)
      ) {
        // Plugin-owned retry: the same loop ended again; clear the workflow and
        // retry the pending terminal hook.
        await Session.update(sessionID, (draft) => {
          if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
        })
        clearDeadlineTimer(sessionID)
        await deliverTerminalHook(session, existing)
        return
      }
      if (!activeLoop) {
        // Idempotent re-entry (no active loop on this session) or a stale
        // record with no matching loop: preserve the existing record and retry
        // its hook delivery instead of replacing it.
        await deliverTerminalHook(session, existing)
        return
      }
      // A different loop is ending on this session — either an ordinary loop on
      // top of a stale plugin record, or a plugin loop whose owner does not
      // match the retained record. Retry the stale hook best-effort (the old
      // loop's completion notification), then replace the record with the
      // fresh terminal state for the current loop.
      await deliverTerminalHook(session, existing).catch(() => undefined)
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

  /**
   * Mark an active Light Loop as failed after a terminal executor error.
   *
   * When an assistant turn ends in error, the session has no eligible terminal
   * assistant message, so the continuation kernel cannot drive the loop again
   * and it would otherwise stay active forever (headless drivers would wait
   * out the full hard timeout). This converts that stuck state into the
   * durable `failed` terminal status through the single terminal path.
   *
   * Non-loop sessions and already-terminal loops are left untouched, and
   * aborts (which take the cancellation path) never pass through here.
   */
  export async function failActiveLoop(sessionID: string, error?: unknown): Promise<void> {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session || !isActiveLightLoopWorkflow(session.workflow)) return
    await setTerminalStatus(sessionID, "failed", errorText(error))
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
