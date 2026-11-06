import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import {
  isActiveLightLoopWorkflow,
  type LightLoopTerminalStatus,
  type LightLoopWorkflow,
} from "../session/light-loop-state"
import { LightLoopTerminalStore, type LightLoopTerminalRecord } from "./terminal-hook"

/** Structural shape of the plugin hook-delivery result the terminal path
 * consumes; the concrete implementation is injected from the explicit plugin bridge so the light-loop domain does not import the plugin domain. */
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

const runtimeState = RuntimeContext.state(() => ({
  terminalHookDeliverer: undefined as TerminalHookDeliverer | undefined,
  activeTimers: new Map<string, Timer>(),
}))

/** The plugin-light-loop component injects Plugin.deliverHookForPlugin here; without
 * it, plugin-owned terminal hooks record a durable delivery error instead of
 * silently vanishing. */
export function setTerminalHookDeliverer(deliverer: TerminalHookDeliverer): void {
  const instanceState = runtimeState()

  RuntimeContext.assertCompositionOpen("Light Loop terminal hook")
  if (instanceState.terminalHookDeliverer) throw new Error("Light Loop terminal hook is already registered")
  instanceState.terminalHookDeliverer = deliverer
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

function timerKey(executionSessionID: string): string {
  return `lightloop_deadline:${executionSessionID}`
}

function terminalHookLock(executionSessionID: string): string {
  return `lightloop_terminal_hook:${executionSessionID}`
}

async function deliverTerminalHook(session: Awaited<ReturnType<typeof Session.get>>, record: LightLoopTerminalRecord) {
  const instanceState = runtimeState()

  if (record.hookDeliveredAt !== undefined) return
  if (!record.pluginOwner) {
    // Ordinary (non-plugin) loops have no lightloop.after hook. The record
    // exists so headless drivers can read the authoritative terminal status
    // after the workflow is cleared; acknowledge it directly.
    await LightLoopTerminalStore.acknowledge(session)
    return
  }
  if (!instanceState.terminalHookDeliverer) {
    await LightLoopTerminalStore.recordHookError(
      session,
      "Hook lightloop.after delivery unavailable: plugin registration not loaded",
    )
    return
  }
  const delivery = await instanceState
    .terminalHookDeliverer(record.pluginOwner.pluginId, record.pluginOwner.pluginGeneration, "lightloop.after", {
      loop: {
        sessionID: record.sessionID,
        status: record.status,
        instructions: record.instructions,
        ...(record.error ? { error: record.error } : {}),
      },
    })
    .catch((hookError: unknown) => ({
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
  const instanceState = runtimeState()

  clearDeadlineTimer(executionSessionID)
  const delayMs = Math.max(0, deadlineAt - Date.now())
  if (delayMs <= 0) {
    onExpire()
    return
  }
  const timer = setTimeout(
    () => setDeadlineTimer(executionSessionID, deadlineAt, onExpire),
    Math.min(delayMs, 2_147_483_647),
  )
  timer.unref()
  instanceState.activeTimers.set(timerKey(executionSessionID), timer)
}

function clearDeadlineTimer(executionSessionID: string) {
  const instanceState = runtimeState()

  const existing = instanceState.activeTimers.get(timerKey(executionSessionID))
  if (existing) {
    clearTimeout(existing)
    instanceState.activeTimers.delete(timerKey(executionSessionID))
  }
}

export namespace LightLoopRuntime {
  /**
   * Reattach active deadlines and retry unacknowledged terminal hooks.
   * Called during runtime init/reload after sessions are loaded from storage.
   */
  export async function reattachPluginTimers(): Promise<void> {
    const instanceState = runtimeState()

    const scopeID = ScopeContext.current.scope.id
    const nav = await SessionNav.readNavIndex(scopeID)
    const candidates = new Set(
      nav.entries.filter((entry) => entry.workflow?.kind === "lightloop").map((entry) => entry.id),
    )
    for await (const terminal of LightLoopTerminalStore.list(scopeID)) {
      if (terminal.hookDeliveredAt !== undefined && !candidates.has(terminal.sessionID)) continue
      candidates.add(terminal.sessionID)
    }
    for (const sessionID of candidates) {
      const session = await Session.get(sessionID).catch((error: unknown) => {
        if (!(error instanceof Storage.NotFoundError)) throw error
      })
      if (!session) continue
      {
        using _ = await Lock.write(terminalHookLock(sessionID))
        const current = await LightLoopTerminalStore.get(session)
        if (current) await deliverTerminalHook(session, current).catch(() => undefined)
      }
      const workflow = session.workflow
      if (workflow?.kind !== "lightloop" || !workflow.pluginOwner || !workflow.deadlineAt) continue
      if (instanceState.activeTimers.has(timerKey(session.id))) continue
      scheduleDeadline(session.id, workflow.deadlineAt)
    }
  }

  export async function setTerminalStatus(
    sessionID: string,
    status: LightLoopTerminalStatus,
    error?: string,
    expected?: LightLoopWorkflow,
  ): Promise<void> {
    using _ = await Lock.write(terminalHookLock(sessionID))
    const session = await Session.get(sessionID)
    const existing = await LightLoopTerminalStore.get(session)
    if (existing) await deliverTerminalHook(session, existing).catch(() => undefined)
    const terminal = await Storage.transaction(async () => {
      const current = await Session.get(sessionID)
      const workflow = current.workflow
      if (workflow?.kind !== "lightloop") return
      if (expected && JSON.stringify(workflow) !== JSON.stringify(expected)) return
      const record: LightLoopTerminalRecord = {
        sessionID,
        status,
        instructions: workflow.instructions,
        ...(workflow.pluginOwner ? { pluginOwner: workflow.pluginOwner } : {}),
        ...(error ? { error } : {}),
        createdAt: Date.now(),
      }
      await LightLoopTerminalStore.put(current, record)
      await Session.update(sessionID, (draft) => {
        draft.workflow = undefined
      })
      return record
    })
    if (!terminal) return
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
    const session = await Session.get(sessionID).catch((error: unknown) => {
      if (!(error instanceof Storage.NotFoundError)) throw error
    })
    if (!session || !isActiveLightLoopWorkflow(session.workflow)) return
    await setTerminalStatus(sessionID, "failed", errorText(error))
  }

  export function scheduleDeadline(sessionID: string, deadlineAt: number) {
    setDeadlineTimer(sessionID, deadlineAt, async () => {
      try {
        const session = await Session.get(sessionID)
        if (session.workflow?.kind !== "lightloop" || session.workflow.deadlineAt !== deadlineAt) return
        await SessionAbort.abort(sessionID, { internalCancel: true })
        await setTerminalStatus(sessionID, "timed_out", "deadline exceeded", session.workflow)
      } catch {
        // best effort
      }
    })
  }

  export function cancelDeadline(sessionID: string) {
    clearDeadlineTimer(sessionID)
  }
}
