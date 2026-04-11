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
import { Scope } from "@/scope"
import { Instance } from "@/scope/instance"
import { Info, type StatusInfo } from "./types"
import { SessionEndpoint } from "./endpoint"

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
      noReply?: boolean
      summary?: {
        title?: string
      }
      model?: Model
      metadata?: Record<string, any>
    }

    export interface Assistant {
      type: "assistant"
      parts: MessageV2.Part[]
      model?: Model
      agentID?: string
      metadata?: Record<string, any>
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
    mailbox: SessionMail[]
    lastActiveAt: number
  }

  const runtimes = new Map<string, SessionRuntime>()

  const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000
  const IDLE_TTL_MS = 30 * 60 * 1000

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [sessionID, runtime] of runtimes) {
      if (runtime.abort) continue
      if (runtime.mailbox.length > 0) continue
      if (now - runtime.lastActiveAt < IDLE_TTL_MS) continue
      runtimes.delete(sessionID)
      log.info("swept idle runtime", { sessionID })
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
      mailbox: [],
      lastActiveAt: Date.now(),
    }
    runtimes.set(sessionID, runtime)
    log.info("registered runtime", { sessionID })
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
    return Instance.provide({
      scope: session.scope as Scope,
      fn,
    })
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

    if (runtime.mailbox.length > 0 && mailboxHandler) {
      await run(sessionID, () => mailboxHandler!(sessionID))
    }
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
        const session = await requireSession(runtime.sessionID)
        if ((session.scope as Scope).id !== scopeID) continue
      }
      result[runtime.sessionID] = runtime.status
    }
    return result
  }

  // --- Mailbox ---

  type MailboxHandler = (sessionID: string) => Promise<void>
  let mailboxHandler: MailboxHandler | undefined

  export function onMailboxReady(handler: MailboxHandler) {
    mailboxHandler = handler
  }

  export async function deliver(input: { target: string | SessionEndpoint.Info; mail: SessionMail }): Promise<void> {
    const session = await getSession(input.target)
    if (!session) {
      log.warn("deliver: session not found, skipping", {
        target: typeof input.target === "string" ? input.target : SessionEndpoint.toKey(input.target),
      })
      return
    }

    const runtime = registerRuntime(session.id)
    runtime.lastActiveAt = Date.now()
    runtime.mailbox.push(input.mail)

    if (isRunning(session.id)) {
      log.info("mail queued (session running)", { sessionID: session.id, mailboxSize: runtime.mailbox.length })
      return
    }

    log.info("mail queued (session idle), processing", { sessionID: session.id, mailboxSize: runtime.mailbox.length })

    if (mailboxHandler) {
      await run(session.id, () => mailboxHandler!(session.id))
    }
  }

  export function drainMails(sessionID: string, type: "user"): SessionMail.User[]
  export function drainMails(sessionID: string, type: "assistant"): SessionMail.Assistant[]
  export function drainMails(sessionID: string, type: "user" | "assistant"): SessionMail[] {
    const runtime = getRuntime(sessionID)
    if (!runtime) return []
    const matching: SessionMail[] = []
    const remaining: SessionMail[] = []
    for (const mail of runtime.mailbox) {
      if (mail.type === type) matching.push(mail)
      else remaining.push(mail)
    }
    runtime.mailbox.length = 0
    runtime.mailbox.push(...remaining)
    return matching
  }

  export function drainAllMails(sessionID: string): SessionMail[] {
    const runtime = getRuntime(sessionID)
    if (!runtime) return []
    return runtime.mailbox.splice(0)
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

  // --- Internal ---

  function emitStatus(runtime: SessionRuntime, status: StatusInfo): void {
    const payload = { sessionID: runtime.sessionID, status }
    try {
      Bus.publish(SessionEvent.Status, payload)
      if (status.type === "idle") {
        Bus.publish(SessionEvent.Idle, { sessionID: runtime.sessionID })
      }
    } catch (e) {
      if (!(e instanceof Context.NotFound)) throw e
      void requireSession(runtime.sessionID).then((session) => {
        const scope = session.scope as Scope
        GlobalBus.emit("event", {
          directory: scope.directory,
          payload: {
            type: "session.status",
            properties: payload,
          },
        })
        if (status.type === "idle") {
          GlobalBus.emit("event", {
            directory: scope.directory,
            payload: {
              type: "session.idle",
              properties: { sessionID: runtime.sessionID },
            },
          })
        }
      })
    }
  }
}
