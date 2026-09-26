import { RuntimeContext } from "../lifecycle/context"
/**
 * S9c source inversion: the L1 session domain reaches the cortex product
 * domain (delegated-task introspection, running-task reminders, parent
 * notification reconciliation, abort cancellation, plugin task snapshots)
 * through this registry instead of importing it. The L4 product manifest
 * registers the implementation; unregistered access degrades quietly (no
 * delegated context, no reminders, no reconciliation, no snapshots).
 */
export namespace SessionCortexRuntime {
  export interface DelegatedTask {
    parentSessionID: string
    dagNodeId?: string
  }

  export interface RunningTaskRow {
    id: string
    agent: string
    description: string
    startedAt: number
    health: string
    lastTool?: string
    lastToolStatus?: string
  }

  /** Structural view of the plugin task snapshot consumed by interrupted
   * delegation reconciliation (observability emit + cortex.task.after). */
  export interface PluginTaskSnapshotInfo {
    taskId: string
    sessionId: string
    status: string
    agent: string
    model?: { providerID: string; modelID: string }
    startedAt: number
    completedAt?: number
    usage?: unknown
    owner: { pluginId: string; pluginGeneration: string; scopeId: string; correlationId: string }
  }

  export interface Provider {
    /** First task bound to the session when it runs as a delegated subagent. */
    delegatedTask(sessionID: string): Promise<DelegatedTask | undefined>
    /** Visible running tasks parented by the session, with describe() fields. */
    runningTaskRows(parentSessionID: string): Promise<RunningTaskRow[]>
    /** Queued or running tasks parented by the session (continuation blockers). */
    activeTaskRows(sessionID: string): Promise<Array<{ id: string; description: string }>>
    reconcileParentNotifications(scopeID?: string): Promise<void>
    cancelAllForParent(parentSessionID: string): Promise<void>
    cancelAndDrainTask?(taskID: string): Promise<void>
    stop?(): Promise<void>
    pluginTaskSnapshot(
      handle: { taskId: string; sessionId: string },
      delegation: unknown,
    ): PluginTaskSnapshotInfo | undefined
    /** In-memory runtime view of a plugin task (execution timeout clamp). */
    taskInfo(taskId: string): { timeoutMs?: number } | undefined
    /** Resolve when the plugin task reaches a terminal state or the wait times out. */
    waitForTask(taskId: string, timeoutSeconds: number): Promise<unknown>
  }

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider): void {
    const instanceState = runtimeState()

    if (instanceState.provider === value) return
    RuntimeContext.assertCompositionOpen("session/cortex-runtime")
    if (instanceState.provider && value) throw new Error("session/cortex-runtime is already registered")
    instanceState.provider = value
  }

  export function get(): Provider | undefined {
    const instanceState = runtimeState()

    return instanceState.provider
  }

  export async function delegatedTask(sessionID: string): Promise<DelegatedTask | undefined> {
    const instanceState = runtimeState()

    return instanceState.provider?.delegatedTask(sessionID)
  }

  export async function runningTaskRows(parentSessionID: string): Promise<RunningTaskRow[]> {
    const instanceState = runtimeState()

    return instanceState.provider?.runningTaskRows(parentSessionID) ?? []
  }

  export async function activeTaskRows(sessionID: string): Promise<Array<{ id: string; description: string }>> {
    const instanceState = runtimeState()

    return instanceState.provider?.activeTaskRows(sessionID) ?? []
  }

  export async function reconcileParentNotifications(scopeID?: string): Promise<void> {
    const instanceState = runtimeState()

    await instanceState.provider?.reconcileParentNotifications(scopeID)
  }

  export async function cancelAllForParent(parentSessionID: string): Promise<void> {
    const instanceState = runtimeState()

    await instanceState.provider?.cancelAllForParent(parentSessionID)
  }

  export async function cancelAndDrainTask(taskID: string): Promise<void> {
    const instanceState = runtimeState()

    if (!instanceState.provider?.cancelAndDrainTask) throw new Error("Cortex cancellation runtime is unavailable")
    await instanceState.provider.cancelAndDrainTask(taskID)
  }

  export async function stop(): Promise<void> {
    const instanceState = runtimeState()

    await instanceState.provider?.stop?.()
  }

  export function pluginTaskSnapshot(
    handle: { taskId: string; sessionId: string },
    delegation: unknown,
  ): PluginTaskSnapshotInfo | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.pluginTaskSnapshot(handle, delegation)
  }

  export function taskInfo(taskId: string): { timeoutMs?: number } | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.taskInfo(taskId)
  }

  export function waitForTask(taskId: string, timeoutSeconds: number): Promise<unknown> {
    const instanceState = runtimeState()

    return instanceState.provider?.waitForTask(taskId, timeoutSeconds) ?? Promise.resolve(undefined)
  }
}
