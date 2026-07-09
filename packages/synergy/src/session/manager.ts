import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Context } from "@/util/context"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import type { MessageV2 } from "./message-v2"
import { BusyError } from "./error"
import { SessionEvent } from "./event"
import type { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Info, type StatusInfo } from "./types"
import { SessionEndpoint } from "./endpoint"
import { SessionInbox } from "./inbox"

const log = Log.create({ service: "session.manager" })

export namespace SessionManager {
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

  export interface SessionRuntime {
    sessionID: string
    status: StatusInfo
    abort?: AbortController
    waiters: {
      onComplete(result: MessageV2.WithParts): void
      onCancel(): void
    }[]
    lastActiveAt: number
    isChild: boolean
  }

  const runtimes = new Map<string, SessionRuntime>()

  // A session's scope is immutable for its lifetime, so the sessionID -> scopeID
  // mapping can be cached permanently. This removes the two per-delta disk reads
  // that `requireSession` performs on the streaming hot path (issue #350 H1):
  // `updatePart` only needs the scopeID to build the storage path, not the full
  // session info. Entries are tiny (ULID -> scopeID strings) and dropped when a
  // session is deleted (`forgetSession`).
  const scopeIDCache = new Map<string, string>()

  function rememberScopeID(sessionID: string, scopeID: string) {
    scopeIDCache.set(sessionID, scopeID)
  }

  export function forgetSession(sessionID: string) {
    scopeIDCache.delete(sessionID)
  }

  /** Cached scopeID lookup, warm during an active loop. */
  export function cachedScopeID(sessionID: string): string | undefined {
    return scopeIDCache.get(sessionID)
  }

  /**
   * Resolve a session's scopeID with a permanent cache. On a cache miss this
   * reads only the small session-index record (`{ scopeID }`), not the full
   * session info, and memoizes the result. Used by the streaming part-write
   * path so per-delta persistence never re-reads session state.
   */
  export async function resolveScopeID(sessionID: string): Promise<string> {
    const cached = scopeIDCache.get(sessionID)
    if (cached) return cached
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
    if (!indexed) throw new Storage.NotFoundError({ message: `Session ${sessionID} not found` })
    rememberScopeID(sessionID, indexed.scopeID)
    return indexed.scopeID
  }

  const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000
  const USER_IDLE_TTL_MS = 30 * 60 * 1000
  const CHILD_SESSION_IDLE_TTL_MS = 5 * 60 * 1000

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [sessionID, runtime] of runtimes) {
      if (runtime.abort) {
        if (runtime.abort.signal.aborted) {
          runtime.abort = undefined
        } else {
          continue
        }
      }
      const ttl = runtime.isChild ? CHILD_SESSION_IDLE_TTL_MS : USER_IDLE_TTL_MS
      if (now - runtime.lastActiveAt < ttl) continue
      runtimes.delete(sessionID)
      log.info("swept idle runtime", { sessionID, isChild: runtime.isChild })
    }
  }, IDLE_SWEEP_INTERVAL_MS)
  sweepTimer.unref()

  async function readSessionInfo(scopeID: string, sessionID: Identifier.SessionID): Promise<Info | undefined> {
    return Storage.read<Info>(StoragePath.sessionInfo(Identifier.asScopeID(scopeID), sessionID)).catch(() => undefined)
  }

  export async function getSessionID(endpoint: SessionEndpoint.Info): Promise<string | undefined> {
    const endpointKey = SessionEndpoint.toKey(endpoint)
    const candidateSessionIDs = await Storage.scan(StoragePath.endpointSessionRoot(endpointKey)).catch(() => [])

    for (const candidateSessionID of candidateSessionIDs) {
      const sessionID = Identifier.asSessionID(candidateSessionID)
      const indexed = await Storage.read<{ scopeID: string }>(
        StoragePath.endpointSession(endpointKey, sessionID),
      ).catch(() => undefined)
      if (!indexed) continue

      const info = await readSessionInfo(indexed.scopeID, sessionID)
      if (!info || info.time.archived || !info.endpoint) continue
      if (SessionEndpoint.toKey(info.endpoint) !== endpointKey) continue
      return info.id
    }
    return undefined
  }

  export async function getSession(input: string | SessionEndpoint.Info): Promise<Info | undefined> {
    const sessionID = typeof input === "string" ? input : await getSessionID(input)
    if (!sessionID) return undefined
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
    if (!indexed) return undefined
    rememberScopeID(sessionID, indexed.scopeID)
    return Storage.read<Info>(
      StoragePath.sessionInfo(Identifier.asScopeID(indexed.scopeID), Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
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
      GlobalBus.emit("event", {
        directory: scope.type === "home" ? "home" : scope.directory,
        payload: {
          type: SessionEvent.Updated.type,
          properties,
        },
      })
    }
  }

  export function registerRuntime(sessionID: string): SessionRuntime {
    const existing = runtimes.get(sessionID)
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
    runtimes.set(sessionID, runtime)
    log.info("registered runtime", { sessionID })
    return runtime
  }

  export function registerChildRuntime(sessionID: string): SessionRuntime {
    const existing = runtimes.get(sessionID)
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
    runtimes.set(sessionID, runtime)
    log.info("registered child runtime", { sessionID })
    return runtime
  }

  export function unregisterRuntime(sessionID: string): void {
    const runtime = getRuntime(sessionID)
    if (!runtime) return
    runtimes.delete(sessionID)
    log.info("unregistered runtime", { sessionID })
  }

  export function getRuntime(sessionID: string): SessionRuntime | undefined {
    return runtimes.get(sessionID)
  }

  export async function run<T>(input: string | SessionEndpoint.Info, fn: () => Promise<T>): Promise<T> {
    const session = await requireSession(input)
    registerRuntime(session.id)
    try {
      const scope = session.scope as Scope
      const workspace = (session as Info).workspace ?? {
        type: "main" as const,
        path: scope.directory,
        scopeID: scope.id,
      }
      const { ScopeRuntime } = await import("@/scope/runtime")
      return await ScopeRuntime.provide({
        scope,
        workspace,
        ensure: scope.type === "project",
        fn: async () => {
          assertExecutionContext(session, "session manager run")
          const workspace = (session as Info).workspace
          if (workspace?.type !== "git_worktree") return fn()
          const { Worktree } = await import("../project/worktree")
          await Worktree.lock(workspace.path)
          try {
            return await fn()
          } finally {
            await Worktree.unlock(workspace.path)
          }
        },
      })
    } finally {
      const runtime = getRuntime(session.id)
      if (runtime && !runtime.abort) {
        unregisterRuntime(session.id)
      }
    }
  }

  export function assertExecutionContext(session: Info, phase: string): void {
    const expected = session.workspace
    if (!expected || expected.type !== "git_worktree") return

    const actualWorkspace = ScopeContext.tryWorkspace()
    if (actualWorkspace?.path === expected.path) return

    const actualPath = actualWorkspace?.path ?? ScopeContext.tryScope()?.directory
    log.error("session execution workspace mismatch", {
      sessionID: session.id,
      phase,
      expected: expected.path,
      actual: actualPath,
      actualType: actualWorkspace?.type ?? "scope",
    })
    throw new Error(
      [
        `Session ${session.id} is bound to worktree ${expected.path},`,
        `but ${phase} is running in ${actualPath ?? "no workspace context"}.`,
        "Refusing to continue outside the session workspace.",
      ].join(" "),
    )
  }

  export function acquire(sessionID: string): AbortSignal | undefined {
    const runtime = getRuntime(sessionID)
    if (!runtime) {
      log.warn("acquire: session runtime not loaded", { sessionID })
      return undefined
    }
    if (runtime.abort) return undefined
    runtime.lastActiveAt = Date.now()
    const controller = new AbortController()
    runtime.abort = controller
    runtime.status = { type: "busy" }
    return controller.signal
  }

  export function signalAbort(sessionID: string): void {
    const runtime = getRuntime(sessionID)
    if (!runtime) return

    const abort = runtime.abort
    if (abort) {
      abort.abort()
      for (const callback of runtime.waiters) {
        callback.onCancel()
      }
      runtime.waiters = []
    }
    runtime.abort = undefined
  }

  export async function release(sessionID: string): Promise<void> {
    const runtime = getRuntime(sessionID)
    if (!runtime) return

    const abort = runtime.abort
    if (abort) {
      abort.abort()
      for (const callback of runtime.waiters) {
        callback.onCancel()
      }
      runtime.waiters = []
    }
    runtime.abort = undefined

    runtime.status = { type: "idle" }
    emitStatus(runtime, runtime.status)
    await emitSessionUpdated(sessionID).catch((error) => {
      log.warn("failed to emit session update after release", { sessionID, error })
    })

    if (await SessionInbox.hasRunnableItem(sessionID)) {
      scheduleWake(sessionID, "release")
    }
  }

  export async function wake(sessionID: string): Promise<void> {
    if (isRunning(sessionID)) return
    if (!(await SessionInbox.hasRunnableItem(sessionID))) return
    const { SessionInvoke } = await import("./invoke")
    await SessionInvoke.loop(sessionID)
  }

  export function scheduleWake(sessionID: string, reason: string): void {
    setTimeout(() => {
      void wake(sessionID).catch((error) => {
        log.error("async session wake failed", { sessionID, reason, error })
      })
    }, 0)
  }

  export function setStatus(sessionID: string, status: StatusInfo): void {
    const runtime = getRuntime(sessionID)
    if (!runtime) return
    runtime.status = status
    emitStatus(runtime, status)
  }

  export function isRunning(sessionID: string): boolean {
    return !!getRuntime(sessionID)?.abort
  }

  export function assertIdle(sessionID: string): void {
    if (getRuntime(sessionID)?.abort) {
      throw new BusyError(sessionID)
    }
  }

  export function listRunningRuntimes(): SessionRuntime[] {
    return Array.from(runtimes.values()).filter((e) => e.abort)
  }

  export async function listStatuses(scopeID?: string): Promise<Record<string, StatusInfo>> {
    const result: Record<string, StatusInfo> = {}
    for (const runtime of runtimes.values()) {
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
      if (!runtime.abort) unregisterRuntime(session.id)
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

  // --- Pending Reply ---

  export async function listPendingReply(): Promise<string[]> {
    const scopeRoots = await Storage.scan(["sessions"])
    const sessionIDs = new Set<string>()

    for (const scopeID of scopeRoots) {
      const ids = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
      for (const sessionID of ids) {
        const info = await Storage.read<Info>(
          StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
        ).catch(() => undefined)
        if (!info || info.time.archived || info.pendingReply !== true) continue
        sessionIDs.add(info.id)
      }
    }

    return Array.from(sessionIDs)
  }

  export async function listInterruptedCortexDelegations(): Promise<string[]> {
    const scopeRoots = await Storage.scan(["sessions"])
    const sessionIDs = new Set<string>()

    for (const scopeID of scopeRoots) {
      const ids = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
      for (const sessionID of ids) {
        if (isRunning(sessionID)) continue
        const info = await Storage.read<Info>(
          StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
        ).catch(() => undefined)
        if (!info || info.time.archived) continue
        if (info.cortex?.status !== "queued" && info.cortex?.status !== "running") continue
        sessionIDs.add(info.id)
      }
    }

    return Array.from(sessionIDs)
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
          GlobalBus.emit("event", {
            directory: scope.directory,
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
