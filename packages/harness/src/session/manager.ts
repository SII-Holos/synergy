import { SessionRecords } from "./records"
import { ExecutionCapacity } from "./execution-capacity"
import { WorkspaceAccess } from "../workspace/access"
import { RuntimeContext } from "../lifecycle/context"
import { SessionInputProgress } from "./input-progress"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Context } from "../util/context"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { StorageRecovery } from "../storage/recovery"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { SessionCompat } from "./compat-import"
import type { MessageV2 } from "./message-v2"
import { BusyError, PausedTurnAbort } from "./error"
import { SessionEvent } from "./event"
import type { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Info, type StatusInfo } from "./types"
import { SessionEndpoint } from "./endpoint"
import { SessionMemoryPressure } from "./memory-pressure"
import { SessionInbox } from "./inbox"
import { SessionLifecycle } from "./lifecycle"
import { ObservabilityMetrics } from "../observability/metrics"
import { SessionWorkspaceRuntime } from "./workspace-runtime"

const log = Log.create({ service: "session.manager" })

export namespace SessionManager {
  export async function waitForIdle(sessionID: string): Promise<void> {
    const lease = getRuntime(sessionID)?.owner?.lease
    await Promise.all([
      runtimeState().sessionCompletions.get(sessionID),
      lease ? runtimeState().leaseReleases.get(lease)?.promise : undefined,
    ])
  }
  export namespace SessionMail {
    export interface Model {
      providerID: string
      modelID: string
    }

    export interface User {
      type: "user"
      parts: MessageV2.Part[]
      agent?: string
      noReply?: boolean
      summary?: {
        title?: string
      }
      model?: Model
      metadata?: Record<string, any>
      inboxItemID?: string
      tools?: Record<string, boolean>
    }

    export interface Assistant {
      type: "assistant"
      parts: MessageV2.Part[]
      model?: Model
      agentID?: string
      metadata?: Record<string, any>
      inboxItemID?: string
    }
  }

  export type SessionMail = SessionMail.User | SessionMail.Assistant

  export type LoopPhase = "starting" | "running" | "stopping"
  export type ExecutionPhase =
    | "queued_agent"
    | "running_agent"
    | "authorizing_tools"
    | "queued_tools"
    | "running_tools"
    | "waiting_background"
    | "stopping"

  export interface LoopLease {
    readonly sessionID: string
    readonly generation: number
    readonly signal: AbortSignal
  }

  export interface LoopOwner {
    lease: LoopLease
    controller: AbortController
    phase: LoopPhase
    rootID?: string
    /** Set by an internal cancellation (Cortex) that owns the session's queued work: fenced cleanup
     *  discards items queued before this timestamp at the loop boundary, preserving mail delivered
     *  after the cancelled acknowledgement, and release stops requesting follow-up work unless such
     *  post-fence work exists. */
    fenceQueuedWork?: boolean
    fenceQueuedBefore?: number
  }

  export interface SessionRuntime {
    sessionID: string
    status: StatusInfo
    executionPhase?: ExecutionPhase
    executionPhaseStartedAt?: number
    owner?: LoopOwner
    waiters: {
      onComplete(result: MessageV2.WithParts): void
      onCancel(): void
    }[]
    lastActiveAt: number
    isChild: boolean
  }
  const runtimeState = RuntimeContext.state(() => ({
    nextOwnerGeneration: 0,
    leaseReleases: new WeakMap<LoopLease, ReturnType<typeof Promise.withResolvers<void>>>(),
    sessionCompletions: new Map<string, Promise<void>>(),
    runtimes: new Map<string, SessionRuntime>(),
    running: new Set<Promise<void>>(),
    accepting: true,
    activeWakeChains: new Map<string, { requested: boolean }>(),
    wakeTimers: new Set<ReturnType<typeof setTimeout>>(),
  }))
  const owns = (runtime: SessionRuntime, lease: LoopLease) => runtime.owner?.lease === lease
  const occupied = (runtime: SessionRuntime | undefined) => runtime?.owner !== undefined
  const nextGeneration = () => {
    const instanceState = runtimeState()
    return ++instanceState.nextOwnerGeneration
  }
  const cancelWaiters = (runtime: SessionRuntime) => {
    for (const callback of runtime.waiters) callback.onCancel()
    runtime.waiters = []
  }

  export interface RuntimeStats {
    totalCount: number
    runningCount: number
    idleCount: number
    childCount: number
    userCount: number
    waiterCount: number
    executionPhases: Partial<Record<ExecutionPhase, number>>
  }

  export function closeAdmission() {
    const instanceState = runtimeState()

    instanceState.accepting = false
    for (const timer of instanceState.wakeTimers) clearTimeout(timer)
    instanceState.wakeTimers.clear()
    instanceState.activeWakeChains.clear()
  }
  export function openAdmission() {
    const instanceState = runtimeState()

    instanceState.accepting = true
  }
  export function hasPendingWake(): boolean {
    const state = runtimeState()
    return state.activeWakeChains.size > 0 || state.running.size > 0
  }
  export async function drain() {
    const instanceState = runtimeState()

    while (instanceState.running.size) await Promise.all([...instanceState.running])
  }

  // A session's scope is immutable for its lifetime, so the sessionID -> scopeID
  // mapping can be cached permanently. This removes the two per-delta disk reads
  // that `requireSession` performs on the streaming hot path (issue #350 H1):
  // `updatePart` only needs the scopeID to build the storage path, not the full
  // session info. Entries are tiny (ULID -> scopeID strings) and dropped when a
  // session is deleted (`forgetSession`).
  const scopeIDCache = Storage.state(() => new Map<string, string>())
  const historyRevisions = Storage.state(() => new Map<string, number>())

  function rememberScopeID(sessionID: string, scopeID: string) {
    scopeIDCache().set(sessionID, scopeID)
  }

  export function forgetSession(sessionID: string) {
    scopeIDCache().delete(sessionID)
    historyRevisions().delete(sessionID)
  }

  /** Cached scopeID lookup, warm during an active loop. */
  export function cachedScopeID(sessionID: string): string | undefined {
    return scopeIDCache().get(sessionID)
  }

  export function historyRevision(sessionID: string) {
    return historyRevisions().get(sessionID) ?? 0
  }

  export function bumpHistoryRevision(sessionID: string) {
    const revision = historyRevision(sessionID) + 1
    historyRevisions().set(sessionID, revision)
    return revision
  }

  /**
   * Resolve a session's scopeID with a permanent cache. On a cache miss this
   * reads only the small session-index record (`{ scopeID }`), not the full
   * session info, and memoizes the result. Used by the streaming part-write
   * path so per-delta persistence never re-reads session state.
   */
  export async function resolveScopeID(sessionID: string): Promise<string> {
    const cached = scopeIDCache().get(sessionID)
    if (cached) return cached
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!indexed) throw new Storage.NotFoundError({ message: `Session ${sessionID} not found` })
    rememberScopeID(sessionID, indexed.scopeID)
    return indexed.scopeID
  }

  const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000
  const USER_IDLE_TTL_MS = 30 * 60 * 1000
  const CHILD_SESSION_IDLE_TTL_MS = 5 * 60 * 1000

  function signalRuntimeRelease(reason: string, sessionID: string) {
    SessionMemoryPressure.signalRelease({
      phase: `session.runtime.${reason}`,
      sessionID,
    })
  }

  export function startIdleSweep() {
    const sweepTimer = setInterval(() => {
      const instanceState = runtimeState()

      const now = Date.now()
      for (const [sessionID, runtime] of instanceState.runtimes) {
        if (occupied(runtime)) continue
        const ttl = runtime.isChild ? CHILD_SESSION_IDLE_TTL_MS : USER_IDLE_TTL_MS
        if (now - runtime.lastActiveAt < ttl) continue
        instanceState.runtimes.delete(sessionID)
        log.info("swept idle runtime", { sessionID, isChild: runtime.isChild })
        signalRuntimeRelease("idle_sweep", sessionID)
      }
    }, IDLE_SWEEP_INTERVAL_MS)
    sweepTimer.unref()
    return () => clearInterval(sweepTimer)
  }

  async function readSessionInfo(scopeID: string, sessionID: Identifier.SessionID): Promise<Info | undefined> {
    return SessionRecords.read(StoragePath.sessionInfo(Identifier.asScopeID(scopeID), sessionID)).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export async function getSessionID(endpoint: SessionEndpoint.Info, scopeID?: string): Promise<string | undefined> {
    const endpointKey = SessionEndpoint.toKey(endpoint)
    const candidateSessionIDs = await Storage.scan(StoragePath.endpointSessionRoot(endpointKey)).catch(() => [])

    for (const candidateSessionID of candidateSessionIDs) {
      const sessionID = Identifier.asSessionID(candidateSessionID)
      const indexed = await Storage.read<{ scopeID: string }>(
        StoragePath.endpointSession(endpointKey, sessionID),
      ).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!indexed || (scopeID && indexed.scopeID !== scopeID)) continue

      let info = await readSessionInfo(indexed.scopeID, sessionID)
      if (!info && (await SessionCompat.isActive())) {
        try {
          await SessionCompat.requireImported(sessionID)
          info = await readSessionInfo(indexed.scopeID, sessionID)
        } catch (error) {
          if (!(error instanceof SessionCompat.BlockedError)) throw error
        }
      }
      if (!info || info.time.archived || !info.endpoint) continue
      if (SessionEndpoint.toKey(info.endpoint) !== endpointKey) continue
      return info.id
    }
    return SessionCompat.pendingEndpoint(endpoint, scopeID)
  }

  export async function getSession(input: string | SessionEndpoint.Info, scopeID?: string): Promise<Info | undefined> {
    const sessionID = typeof input === "string" ? input : await getSessionID(input, scopeID)
    if (!sessionID) return undefined
    // Importing must precede the index read: activation's index rebuild only
    // sees imported sessions, so a deferred aggregate has no session_index
    // until this import writes it.
    if (await SessionCompat.isActive()) await SessionCompat.requireImported(sessionID)
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!indexed) return undefined
    rememberScopeID(sessionID, indexed.scopeID)
    return SessionRecords.read(
      StoragePath.sessionInfo(Identifier.asScopeID(indexed.scopeID), Identifier.asSessionID(sessionID)),
    ).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export async function requireSession(input: string | SessionEndpoint.Info): Promise<Info> {
    const session = await getSession(input)
    if (session) return session
    if (typeof input === "string") {
      throw new Storage.NotFoundError({ message: `Session ${input} not found` })
    }
    throw new Storage.NotFoundError({
      message: `Endpoint session not found for ${SessionEndpoint.toKey(input)}`,
    })
  }

  async function emitSessionUpdated(sessionID: string): Promise<void> {
    const session = await getSession(sessionID)
    if (!session) return
    const { Session } = await import(".")
    const properties = { info: await Session.withRuntimeInfo(session) }
    try {
      await Bus.publish(SessionEvent.Updated, properties)
    } catch (error) {
      if (!(error instanceof Context.NotFound)) throw error
      const scope = session.scope as Scope
      GlobalBus().emit("event", {
        scopeID: scope.id,
        payload: {
          type: SessionEvent.Updated.type,
          properties,
        },
      })
    }
  }

  export function registerRuntime(sessionID: string): SessionRuntime {
    const existing = runtimeState().runtimes.get(sessionID)
    if (existing) {
      existing.lastActiveAt = Date.now()
      return existing
    }

    const runtime: SessionRuntime = {
      sessionID,
      status: { type: "idle" },
      waiters: [],
      lastActiveAt: Date.now(),
      isChild: false,
    }
    runtimeState().runtimes.set(sessionID, runtime)
    log.info("registered runtime", { sessionID })
    return runtime
  }

  export function registerChildRuntime(sessionID: string): SessionRuntime {
    const existing = runtimeState().runtimes.get(sessionID)
    if (existing) {
      existing.isChild = true
      existing.lastActiveAt = Date.now()
      return existing
    }

    const runtime: SessionRuntime = {
      sessionID,
      status: { type: "idle" },
      waiters: [],
      lastActiveAt: Date.now(),
      isChild: true,
    }
    runtimeState().runtimes.set(sessionID, runtime)
    log.info("registered child runtime", { sessionID })
    return runtime
  }

  export function unregisterRuntime(sessionID: string): void {
    const runtime = getRuntime(sessionID)
    if (!runtime) return
    runtimeState().runtimes.delete(sessionID)
    log.info("unregistered runtime", { sessionID })
    signalRuntimeRelease("unregister", sessionID)
  }

  export function getRuntime(sessionID: string): SessionRuntime | undefined {
    const instanceState = runtimeState()

    return instanceState.runtimes.get(sessionID)
  }

  export function runtimeStats(): RuntimeStats {
    let runningCount = 0
    let childCount = 0
    let waiterCount = 0
    const executionPhases: Partial<Record<ExecutionPhase, number>> = {}
    for (const runtime of runtimeState().runtimes.values()) {
      if (occupied(runtime)) runningCount++
      if (runtime.isChild) childCount++
      waiterCount += runtime.waiters.length
      if (runtime.executionPhase) {
        executionPhases[runtime.executionPhase] = (executionPhases[runtime.executionPhase] ?? 0) + 1
      }
    }
    return {
      totalCount: runtimeState().runtimes.size,
      runningCount,
      idleCount: runtimeState().runtimes.size - runningCount,
      childCount,
      userCount: runtimeState().runtimes.size - childCount,
      waiterCount,
      executionPhases,
    }
  }

  export async function run<T>(
    sessionID: string,
    fn: (lease: LoopLease) => Promise<T>,
    options?: { lease?: LoopLease; releaseLease?: boolean; requestNextWorkOnFailure?: boolean },
  ): Promise<T> {
    const lease = options?.lease ?? acquire(sessionID)
    const runtime = getRuntime(sessionID)
    if (!lease || lease.sessionID !== sessionID || !runtime || !owns(runtime, lease)) throw new BusyError(sessionID)
    let completed = false
    const completion = Promise.withResolvers<void>()
    runtimeState().running.add(completion.promise)
    runtimeState().sessionCompletions.set(sessionID, completion.promise)

    try {
      const session = await requireSession(sessionID)
      if (session.workspaceID) {
        const { WorkspaceBinding } = await import("../workspace/binding")
        await WorkspaceBinding.validate(session.workspaceID, session.scope.id, session.workspace?.generation)
      }
      const scope = session.scope as Scope
      const workspace = session.workspace
      const { ScopeRuntime } = await import("../scope/runtime")
      const runWithScope = () =>
        ExecutionCapacity.session(sessionID, () =>
          WorkspaceAccess.task({ sessionID, parentSessionID: session.parentID, workspace, signal: lease.signal }, () =>
            ScopeRuntime.provide({
              scope,
              workspace,
              ensure: workspace !== null,
              fn: async () => {
                assertExecutionContext(session, "session manager run")
                const workspace = (session as Info).workspace
                if (workspace?.type !== "git_worktree") {
                  activate(lease)
                  return fn(lease)
                }
                await SessionWorkspaceRuntime.get().lockWorktree(workspace.path)
                try {
                  activate(lease)
                  return await fn(lease)
                } finally {
                  await SessionWorkspaceRuntime.get().unlockWorktree(workspace.path)
                }
              },
            }),
          ),
        )
      let result: T
      if (workspace?.type !== "git_worktree") {
        result = await runWithScope()
      } else {
        result = await SessionWorkspaceRuntime.get().withWorktree(workspace.path, session.id, runWithScope)
      }
      completed = true
      return result
    } finally {
      try {
        if (options?.releaseLease !== false) {
          // Capture before finish(): release() aborts the controller and clears
          // the owner, so the fenced path must be read from the live owner here.
          const owner = runtime?.owner && owns(runtime, lease) ? runtime.owner : undefined
          const fenced = owner?.fenceQueuedWork === true
          const fenceQueuedBefore = owner?.fenceQueuedBefore
          const postFenceWork =
            fenced && fenceQueuedBefore !== undefined
              ? await SessionInbox.hasRunnableItem(sessionID, { createdAfter: fenceQueuedBefore }).catch(() => false)
              : false
          await finish(lease, {
            requestNextWork: (!fenced || postFenceWork) && (completed || options?.requestNextWorkOnFailure !== false),
          })
        }
      } finally {
        runtimeState().running.delete(completion.promise)
        if (runtimeState().sessionCompletions.get(sessionID) === completion.promise)
          runtimeState().sessionCompletions.delete(sessionID)
        completion.resolve()
      }
    }
  }

  export function assertExecutionContext(session: Info, phase: string): void {
    const expected = session.workspace
    const actual = ScopeContext.tryWorkspace()
    const sameWorkspace =
      expected === null
        ? actual === null
        : actual?.id === expected.id &&
          actual?.generation === expected.generation &&
          actual?.path === expected.path &&
          actual.type === expected.type &&
          actual.scopeID === expected.scopeID
    if (sameWorkspace && ScopeContext.tryScope()?.id === session.scope.id) return
    log.error("session execution workspace mismatch", { sessionID: session.id, phase, expected, actual })
    throw new Error(
      `Session ${session.id} workspace does not match ${phase}. Refusing to continue outside the session workspace.`,
    )
  }

  export function acquire(sessionID: string): LoopLease | undefined {
    StorageRecovery.assertRunnable(sessionID)
    if (!runtimeState().accepting) throw new Error("Synergy runtime is shutting down")
    const runtime = registerRuntime(sessionID)
    if (occupied(runtime)) return undefined

    runtime.lastActiveAt = Date.now()
    const controller = new AbortController()
    const lease: LoopLease = {
      sessionID,
      generation: nextGeneration(),
      signal: controller.signal,
    }
    runtime.owner = { lease, controller, phase: "starting" }
    runtimeState().leaseReleases.set(lease, Promise.withResolvers<void>())
    transitionExecutionPhase(runtime, "queued_agent")
    runtime.status = { type: "busy" }
    return lease
  }

  export function activate(lease: LoopLease): boolean {
    const runtime = getRuntime(lease.sessionID)
    if (!runtime || !owns(runtime, lease)) return false
    if (runtime.owner!.phase === "starting") runtime.owner!.phase = "running"
    return runtime.owner!.phase === "running"
  }

  export function bindRootTask(lease: LoopLease, rootID: string) {
    const runtime = getRuntime(lease.sessionID)
    if (!runtime || !owns(runtime, lease) || runtime.owner!.phase === "stopping") return false
    runtime.owner!.rootID = rootID
    return true
  }

  export type AbortOutcome = "not_found" | "idle" | "signaled" | "already_stopping" | "not_owner"

  export function signalAbort(
    sessionID: string,
    options?: {
      fenceQueuedWork?: boolean
      fenceQueuedBefore?: number
      rootID?: string
      /**
       * Stop the turn so it can be resumed instead of ended. The intent rides on
       * the abort itself, so a writer that terminalizes the interrupted turn
       * reads it from the signal it is already reacting to rather than from a
       * flag written by a concurrent repair.
       */
      pauseTurn?: boolean
    },
  ): AbortOutcome {
    const runtime = getRuntime(sessionID)
    if (!runtime) return "not_found"
    const owner = runtime.owner
    if (!owner) return "idle"
    if (options?.rootID && owner.rootID !== options.rootID) return "not_owner"
    // First abort wins. An internal cancellation (Boss/Lattice/Cortex) aborts
    // before removing its own inbox items; a later abort arriving while that
    // cleanup is in flight must not re-enable the release drive, or it would
    // materialize the very items being cancelled.
    if (options?.fenceQueuedWork) {
      owner.fenceQueuedWork = true
      owner.fenceQueuedBefore ??= options.fenceQueuedBefore
    }
    if (owner.phase === "stopping") return "already_stopping"
    owner.phase = "stopping"
    transitionExecutionPhase(runtime, "stopping")
    owner.controller.abort(options?.pauseTurn ? new PausedTurnAbort() : undefined)
    cancelWaiters(runtime)
    return "signaled"
  }

  /** Fence timestamp of the active abort, if it fenced queued work. */
  export function fenceQueuedBefore(sessionID: string): number | undefined {
    const owner = getRuntime(sessionID)?.owner
    return owner?.fenceQueuedWork === true ? owner.fenceQueuedBefore : undefined
  }

  export function completeWaiters(lease: LoopLease, result: MessageV2.WithParts): boolean {
    const runtime = getRuntime(lease.sessionID)
    if (!runtime || !owns(runtime, lease)) return false
    const waiters = runtime.waiters
    runtime.waiters = []
    for (const callback of waiters) callback.onComplete(result)
    return true
  }

  export async function release(lease: LoopLease, options: { requestNextWork?: boolean } = {}): Promise<boolean> {
    const runtime = getRuntime(lease.sessionID)
    if (!runtime || !owns(runtime, lease)) return false

    const pausedTurn = PausedTurnAbort.is(runtime.owner!.lease.signal.reason)
    runtime.owner!.controller.abort()
    cancelWaiters(runtime)
    runtime.owner = undefined
    runtimeState().leaseReleases.get(lease)?.resolve()
    transitionExecutionPhase(runtime, undefined)
    runtime.status = { type: "idle" }
    emitStatus(runtime, runtime.status)
    await emitSessionUpdated(lease.sessionID).catch((error) => {
      log.warn("failed to emit session update after release", { sessionID: lease.sessionID, error })
    })

    if (runtimeState().accepting && !pausedTurn && options.requestNextWork !== false) {
      const { SessionDrive } = await import("./drive")
      await SessionDrive.request(lease.sessionID, "release")
    }
    return true
  }

  export async function finish(lease: LoopLease, options: { requestNextWork?: boolean } = {}): Promise<boolean> {
    const released = await release(lease, options)
    const runtime = getRuntime(lease.sessionID)
    if (runtime && !occupied(runtime)) unregisterRuntime(lease.sessionID)
    return released
  }

  export const WAKE_RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000]

  // A removed worktree fails before any inbox work starts, so no retry can
  // make progress and no queued work can be stranded behind it; the error
  // class lives above this package boundary, so it is recognized by name.
  // InvalidUrlError stays retryable on purpose: steer and context items are
  // drained (deleted) before materialization, so the error can surface after
  // the poisoned item is already gone, and abandoning the chain then would
  // strand runnable work queued behind it.
  const PERMANENT_WAKE_ERROR_NAMES = new Set(["WorktreeNotFoundError"])

  function isPermanentWakeFailure(error: unknown): boolean {
    return error instanceof Error && PERMANENT_WAKE_ERROR_NAMES.has(error.name)
  }

  function scheduleWakeAttempt(sessionID: string, reason: string, delayMs: number, failureCount: number): void {
    const instanceState = runtimeState()

    if (!instanceState.accepting) return
    const timer = setTimeout(() => {
      instanceState.wakeTimers.delete(timer)
      if (!instanceState.accepting) return
      const chain = instanceState.activeWakeChains.get(sessionID)
      if (!chain) return
      chain.requested = false
      const operation = wake(sessionID)
        .then(() => {
          SessionInputProgress.clearFailure(sessionID)
          if (!instanceState.accepting) return
          if (chain.requested) scheduleWakeAttempt(sessionID, reason, 0, 0)
          else instanceState.activeWakeChains.delete(sessionID)
        })
        .catch(async (error) => {
          if (!instanceState.accepting) return
          const terminal = isPermanentWakeFailure(error) || WAKE_RETRY_DELAYS_MS[failureCount] === undefined
          SessionInputProgress.schedulingFailure(sessionID, error, terminal)
          if (terminal) await SessionInbox.failScheduledTask(sessionID).catch(() => {})
          if (isPermanentWakeFailure(error)) {
            instanceState.activeWakeChains.delete(sessionID)
            log.error("async session wake failed permanently", { sessionID, reason, error, permanent: true })
            return
          }
          const delay = WAKE_RETRY_DELAYS_MS[failureCount]
          if (delay === undefined) {
            instanceState.activeWakeChains.delete(sessionID)
            log.error("async session wake failed", { sessionID, reason, error, retriesExhausted: true })
            return
          }
          log.warn("async session wake failed; retrying", { sessionID, reason, error, nextDelayMs: delay })
          scheduleWakeAttempt(sessionID, reason, delay, failureCount + 1)
        })
        .finally(() => instanceState.running.delete(operation))
      instanceState.running.add(operation)
    }, delayMs)
    instanceState.wakeTimers.add(timer)
    timer.unref()
  }

  /**
   * Drive a session, synchronously.
   *
   * Two gates sit in front of the loop, and neither is bypassable:
   *
   * - A paused interactive session is never driven. This is defence in depth
   *   behind `SessionDrive.arbitrate`; a wake that skipped it would restart the
   *   very work the user stopped.
   * - Discovery normally decides whether there is anything to do. `force` skips
   *   only that check, for an explicit user continue whose resume point the
   *   discovery heuristics cannot see.
   */
  export async function wake(sessionID: string, options: { force?: boolean } = {}): Promise<void> {
    if (!runtimeState().accepting) return
    if (isRunning(sessionID)) return
    const session = await getSession(sessionID).catch(() => undefined)
    if (await SessionLifecycle.blocksDrive(session)) return
    if (!options.force && !(await SessionInbox.hasRunnableItem(sessionID))) return
    const { SessionInvoke } = await import("./invoke")
    // A queued item behind an interrupted turn needs that turn settled before
    // the loop can consume it, but settlement must not latch a pause: this wake
    // exists precisely because there is more work to do.
    if (!options.force) {
      await SessionInvoke.settleInterruptedTurn(sessionID).catch((error) => {
        log.warn("session repair before wake failed", { sessionID, error })
      })
    }
    await SessionInvoke.loop(sessionID)
  }

  export function scheduleWake(sessionID: string, reason: string): void {
    SessionInputProgress.clearFailure(sessionID)
    const instanceState = runtimeState()
    if (!instanceState.accepting) return

    const chain = instanceState.activeWakeChains.get(sessionID)
    if (chain) {
      chain.requested = true
      return
    }
    instanceState.activeWakeChains.set(sessionID, { requested: false })
    scheduleWakeAttempt(sessionID, reason, 0, 0)
  }

  export function setStatus(sessionID: string, status: StatusInfo): void {
    const runtime = getRuntime(sessionID)
    if (!runtime) return
    runtime.status = status
    emitStatus(runtime, status)
  }

  export function setExecutionPhase(sessionID: string, phase: ExecutionPhase): void {
    const runtime = getRuntime(sessionID)
    if (!runtime?.owner) return
    transitionExecutionPhase(runtime, phase)
    runtime.lastActiveAt = Date.now()
  }

  function transitionExecutionPhase(runtime: SessionRuntime, phase: ExecutionPhase | undefined): void {
    if (runtime.executionPhase === phase) return
    const now = Date.now()
    if (runtime.executionPhase && runtime.executionPhaseStartedAt !== undefined) {
      ObservabilityMetrics.record({
        name: "session.execution_phase.duration",
        value: now - runtime.executionPhaseStartedAt,
        unit: "ms",
        module: "session",
        sessionID: runtime.sessionID,
        labels: { phase: runtime.executionPhase },
      })
    }
    runtime.executionPhase = phase
    runtime.executionPhaseStartedAt = phase ? now : undefined
  }

  export async function publishStatusOnly(sessionID: string, status: StatusInfo): Promise<void> {
    const session = await requireSession(sessionID)
    const scope = session.scope as Scope
    const properties = { sessionID, status }
    const publish = () => Bus.publish(SessionEvent.Status, properties)
    if (ScopeContext.tryScope()?.id === scope.id) {
      await publish()
      return
    }
    await ScopeContext.provide({ scope, fn: publish })
  }

  export function isRunning(sessionID: string): boolean {
    return occupied(getRuntime(sessionID))
  }

  export function assertIdle(sessionID: string): void {
    if (occupied(getRuntime(sessionID))) throw new BusyError(sessionID)
  }

  export function listRunningRuntimes(): SessionRuntime[] {
    const instanceState = runtimeState()

    return Array.from(instanceState.runtimes.values()).filter(occupied)
  }

  /**
   * Sessions that currently hold a registered runtime: open in this process,
   * either running or idle between turns. Retention treats every one as live,
   * because an idle runtime is still resumable and its newest evidence must
   * survive until the runtime is swept.
   */
  export function liveSessionIDs(): string[] {
    const instanceState = runtimeState()

    return [...instanceState.runtimes.keys()]
  }

  /**
   * Number of registered runtimes whose status is not idle. An in-memory,
   * allocation-and-IO-free read over this process's runtimes only: no storage
   * access and no cross-scope recovery scan, unlike listStatuses(), whose
   * no-scope path reads every scope's recoverable sessions from disk. A session
   * still queued for recovery after a restart is not counted until it actually
   * begins executing. Intended for cheap polling (e.g. the Desktop keep-awake
   * predicate) that must not scale with scope or session counts.
   */
  export function activeRuntimeCount(): number {
    let count = 0
    for (const runtime of runtimeState().runtimes.values()) {
      if (runtime.status.type !== "idle") count++
    }
    return count
  }

  export async function listStatuses(scopeID?: string): Promise<Record<string, StatusInfo>> {
    const result: Record<string, StatusInfo> = {}
    for (const runtime of runtimeState().runtimes.values()) {
      if (runtime.status.type === "idle") continue
      if (scopeID) {
        const session = await getSession(runtime.sessionID)
        if (!session) {
          unregisterRuntime(runtime.sessionID)
          continue
        }
        if ((session.scope as Scope).id !== scopeID) continue
      }
      result[runtime.sessionID] = runtime.status
    }
    const { SessionNav } = await import("./nav")
    const { SessionRecovery } = await import("./recovery")
    const scopeIDs = scopeID ? [scopeID] : await SessionNav.getAllScopeIDs()
    // Sequential like the other cross-scope scans: each scope reads session records from the same
    // store, so parallel scans only contend.
    for (const id of scopeIDs) {
      const recovered = await SessionRecovery.recoverableStatuses(id).catch((error) => {
        log.warn("failed to resolve recoverable session statuses", { scopeID: id, error })
        return {}
      })
      for (const [sessionID, status] of Object.entries(recovered)) {
        result[sessionID] ??= status
      }
    }
    return result
  }

  // --- Inbox delivery ---

  /**
   * Deliver a SessionMail into the persistent inbox and wake the target session
   * when appropriate. Thin adapter over SessionInbox: it converts the mail DTO
   * to a mode-based inbox item (with source labels) and owns the idle-wake logic
   * that SessionInbox cannot (runtime management lives here).
   */
  export async function deliver(input: {
    target: string | SessionEndpoint.Info
    mail: SessionMail
    waitForProcessing?: boolean
  }): Promise<void> {
    const session = await getSession(input.target)
    if (!session) {
      log.warn("deliver: session not found, skipping", {
        target: typeof input.target === "string" ? input.target : SessionEndpoint.toKey(input.target),
      })
      return
    }

    const runtime = registerRuntime(session.id)
    runtime.lastActiveAt = Date.now()
    const releaseIfIdle = () => {
      if (!occupied(runtime)) unregisterRuntime(session.id)
    }

    if (input.mail.type === "assistant") {
      await SessionInbox.deliver({
        sessionID: session.id,
        mode: "context",
        message: {
          role: "assistant",
          parts: input.mail.parts as any,
          agent: input.mail.agentID,
          model: input.mail.model,
          metadata: input.mail.metadata,
        },
      })
      releaseIfIdle()
      return
    }

    const item = await SessionInbox.enqueueMail({ sessionID: session.id, mail: input.mail })

    if (isRunning(session.id)) {
      log.info("mail queued (session running)", { sessionID: session.id })
      return
    }

    if (item.mode === "context") {
      log.info("context mail queued without waking session", { sessionID: session.id, itemID: item.id })
      releaseIfIdle()
      return
    }

    if (item.mode === "steer" && !(await SessionInbox.latestRootID(session.id))) {
      log.info("steer mail queued without root to resume", { sessionID: session.id, itemID: item.id })
      releaseIfIdle()
      return
    }

    if (input.waitForProcessing === false) {
      log.info("mail queued (session idle), processing asynchronously", { sessionID: session.id })
      releaseIfIdle()
      scheduleWake(session.id, "deliver")
      return
    }

    log.info("mail queued (session idle), processing", { sessionID: session.id })
    await wake(session.id)
  }

  export async function listInterruptedCortexDelegations(scopeID?: string): Promise<string[]> {
    const sessionIDs: string[] = []
    for await (const { value: info } of Storage.records<Info>({ kind: "session", scopeID })) {
      if (!info?.time || info.time.archived || isRunning(info.id)) continue
      if (info.cortex?.status !== "queued" && info.cortex?.status !== "running") continue
      sessionIDs.push(info.id)
    }
    return sessionIDs
  }

  export async function listTerminalCortexDelegations(scopeID?: string): Promise<string[]> {
    const sessionIDs: string[] = []
    for await (const { value: info } of Storage.records<Info>({ kind: "session", scopeID })) {
      if (!info?.time || info.time.archived || !info.cortex) continue
      if (!["completed", "error", "cancelled", "interrupted"].includes(info.cortex.status)) continue
      sessionIDs.push(info.id)
    }
    return sessionIDs
  }

  // --- Internal ---

  function emitStatus(runtime: SessionRuntime, status: StatusInfo): void {
    const payload = { sessionID: runtime.sessionID, status }
    publishStatus(runtime.sessionID, SessionEvent.Status.type, payload, () => Bus.publish(SessionEvent.Status, payload))
    if (status.type === "idle") {
      const idlePayload = { sessionID: runtime.sessionID }
      publishStatus(runtime.sessionID, SessionEvent.Idle.type, idlePayload, () =>
        Bus.publish(SessionEvent.Idle, idlePayload),
      )
    }
  }

  function publishStatus(
    sessionID: string,
    type: string,
    properties: Record<string, unknown>,
    publish: () => Promise<void>,
  ): void {
    void publish().catch((e) => {
      if (!(e instanceof Context.NotFound)) {
        log.error("failed to publish session status event", { sessionID, type, error: e })
        return
      }
      void requireSession(sessionID)
        .then((session) => {
          const scope = session.scope as Scope
          GlobalBus().emit("event", {
            scopeID: scope.id,
            payload: {
              type,
              properties,
            },
          })
        })
        .catch((err) => {
          log.warn("emitStatus fallback: session already cleaned up, event dropped", {
            sessionID,
            type,
            error: (err as Error)?.message ?? String(err),
          })
        })
    })
  }
}
