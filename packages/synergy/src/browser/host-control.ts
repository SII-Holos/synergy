import type { BrowserControl } from "./control.js"
import { BrowserOwner } from "./owner.js"
import { Log } from "../util/log"

export interface BrowserHostControlSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export class BrowserHostControlUnsupportedCommandError extends Error {
  constructor(commandType: string) {
    super(`Browser Host does not support command: ${commandType}`)
    this.name = "BrowserHostControlUnsupportedCommandError"
  }
}

export class BrowserHostControlNotAttachedError extends Error {
  constructor() {
    super("Browser Host control is not attached")
    this.name = "BrowserHostControlNotAttachedError"
  }
}

export namespace BrowserHostControl {
  export type EventPayload = Record<string, unknown>
  export type HostStatus = "pending" | "ready" | "detached" | "restarting" | "failed"

  export interface ReadyMessage {
    type: "browser.host.ready"
    session?: BrowserControl.SessionState
  }

  export interface SessionMessage {
    type: "browser.host.session"
    session: BrowserControl.SessionState
  }

  export interface ResultMessage {
    type: "browser.host.result"
    id: string
    result?: BrowserControl.Result
    error?: { code?: string; message?: string }
  }

  export interface EventMessage {
    type: "browser.host.event"
    event: EventPayload
  }

  export type Message = ReadyMessage | SessionMessage | ResultMessage | EventMessage

  interface PendingRequest {
    resolve(result: BrowserControl.Result): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
    commandType: string
    commandId?: string
    traceId?: string
    startedAt: number
  }

  interface ReadyWaiter {
    resolve(connection: HostConnection): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }

  interface StatusEntry {
    status: HostStatus
    tabId: string | null
    traceId?: string
    reason?: string
    updatedAt: number
  }

  export interface ExecuteOptions {
    commandId?: string
    traceId?: string
    timeoutMs?: number
  }

  const ownerHosts = new Map<string, HostConnection>()
  const tabHosts = new Map<string, Map<string, HostConnection>>()
  const observers = new Map<string, Set<(event: EventPayload) => void>>()
  const globalObservers = new Set<(owner: BrowserOwner.Info, event: EventPayload) => void>()
  const statuses = new Map<string, StatusEntry>()
  const readyWaiters = new Map<string, Set<ReadyWaiter>>()
  const log = Log.create({ service: "browser.host.control" })
  let nextRequestId = 1

  export interface AttachOptions {
    tabId?: string | null
    traceId?: string
  }

  export class HostConnection {
    private pending = new Map<string, PendingRequest>()
    private closed = false
    private ready = false
    session: BrowserControl.SessionState | null = null

    constructor(
      readonly owner: BrowserOwner.Info,
      private socket: BrowserHostControlSocket,
      readonly tabId: string | null = null,
      readonly traceId?: string,
    ) {}

    isReady(): boolean {
      return this.ready && !this.closed
    }

    execute(command: BrowserControl.Command, options: ExecuteOptions = {}): Promise<BrowserControl.Result> {
      if (this.closed) throw new Error("Browser Host control connection is closed")
      const id = `browser_host_${nextRequestId++}`
      const startedAt = Date.now()
      log.info("browser.host.control.command.started", {
        ownerKey: BrowserOwner.key(this.owner),
        tabId: this.tabId,
        commandId: options.commandId ?? id,
        commandType: command.type,
        traceId: options.traceId ?? this.traceId,
      })
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          const error = new Error(`Browser Host command timed out: ${command.type}`)
          log.warn("browser.host.control.command.failed", {
            ownerKey: BrowserOwner.key(this.owner),
            tabId: this.tabId,
            commandId: options.commandId ?? id,
            commandType: command.type,
            traceId: options.traceId ?? this.traceId,
            durationMs: Date.now() - startedAt,
            error: error.message,
          })
          reject(error)
        }, options.timeoutMs ?? 30_000)
        this.pending.set(id, {
          resolve,
          reject,
          timer,
          commandType: command.type,
          commandId: options.commandId,
          traceId: options.traceId,
          startedAt,
        })
        this.send({
          type: "browser.host.command",
          id,
          command,
          commandId: options.commandId,
          traceId: options.traceId ?? this.traceId,
        })
      })
    }

    handleMessage(input: unknown): void {
      if (typeof input !== "object" || input === null) return
      const msg = input as Message
      switch (msg.type) {
        case "browser.host.ready":
          this.ready = true
          this.session = msg.session ? mergeReadySession(this.session, msg.session) : this.session
          markStatus(this.owner, this.tabId, "ready", { traceId: this.traceId })
          if (this.session) emit(this.owner, { type: "session.state", ...this.session })
          break
        case "browser.host.session":
          this.ready = true
          this.session = msg.session
          markStatus(this.owner, this.tabId, "ready", { traceId: this.traceId })
          emit(this.owner, { type: "session.state", ...msg.session })
          break
        case "browser.host.event":
          emit(this.owner, msg.event)
          break
        case "browser.host.result": {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) {
            const message = msg.error.message ?? "Browser Host command failed"
            const error =
              msg.error.code === "unsupported"
                ? new BrowserHostControlUnsupportedCommandError(message)
                : new Error(message)
            log.warn("browser.host.control.command.failed", {
              ownerKey: BrowserOwner.key(this.owner),
              tabId: this.tabId,
              commandId: pending.commandId ?? msg.id,
              commandType: pending.commandType,
              traceId: pending.traceId ?? this.traceId,
              durationMs: Date.now() - pending.startedAt,
              error: message,
            })
            pending.reject(error)
            return
          }
          log.info("browser.host.control.command.completed", {
            ownerKey: BrowserOwner.key(this.owner),
            tabId: this.tabId,
            commandId: pending.commandId ?? msg.id,
            commandType: pending.commandType,
            traceId: pending.traceId ?? this.traceId,
            durationMs: Date.now() - pending.startedAt,
          })
          pending.resolve(msg.result ?? { type: "void" })
          break
        }
      }
    }

    close(): void {
      this.closed = true
      this.ready = false
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error("Browser Host control connection closed"))
        this.pending.delete(id)
      }
    }

    private send(payload: Record<string, unknown>): void {
      this.socket.send(JSON.stringify(payload))
    }
  }

  export function attach(
    owner: BrowserOwner.Info,
    socket: BrowserHostControlSocket,
    options?: AttachOptions,
  ): HostConnection {
    BrowserOwner.assertValid(owner)
    const key = BrowserOwner.key(owner)
    const tabId = options?.tabId ?? null
    const connection = new HostConnection(owner, socket, tabId, options?.traceId)
    if (tabId) {
      const tabs = tabHosts.get(key) ?? new Map<string, HostConnection>()
      tabs.get(tabId)?.close()
      tabs.set(tabId, connection)
      tabHosts.set(key, tabs)
      markStatus(owner, tabId, "pending", { traceId: options?.traceId })
      log.info("browser.host.control.attached", {
        ownerKey: key,
        tabId,
        traceId: options?.traceId,
      })
      return connection
    }
    ownerHosts.get(key)?.close()
    ownerHosts.set(key, connection)
    markStatus(owner, null, "pending", { traceId: options?.traceId })
    log.info("browser.host.control.attached", {
      ownerKey: key,
      tabId: null,
      traceId: options?.traceId,
    })
    return connection
  }

  export function detach(owner: BrowserOwner.Info, connection: HostConnection): void {
    const key = BrowserOwner.key(owner)
    if (connection.tabId) {
      const tabs = tabHosts.get(key)
      if (tabs?.get(connection.tabId) !== connection) return
      tabs.delete(connection.tabId)
      if (tabs.size === 0) tabHosts.delete(key)
    } else {
      if (ownerHosts.get(key) !== connection) return
      ownerHosts.delete(key)
    }
    connection.close()
    markStatus(owner, connection.tabId, "detached", { traceId: connection.traceId })
    log.info("browser.host.control.detached", {
      ownerKey: key,
      tabId: connection.tabId,
      traceId: connection.traceId,
    })
    if (!has(owner)) {
      emit(owner, {
        type: "error",
        severity: "warning",
        code: "browser_host_disconnected",
        message: "Browser Host disconnected.",
      })
    }
  }

  export function get(owner: BrowserOwner.Info, tabId?: string | null): HostConnection | undefined {
    const key = BrowserOwner.key(owner)
    if (tabId) {
      const tabHost = tabHosts.get(key)?.get(tabId)
      if (tabHost) return tabHost
    }
    return ownerHosts.get(key)
  }

  export function has(owner: BrowserOwner.Info): boolean {
    const key = BrowserOwner.key(owner)
    return Boolean(ownerHosts.get(key) || tabHosts.get(key)?.size)
  }

  export function status(owner: BrowserOwner.Info, tabId?: string | null): HostStatus {
    const connection = get(owner, tabId)
    if (connection?.isReady()) return "ready"
    if (connection) return "pending"
    return statuses.get(statusKey(owner, tabId ?? null))?.status ?? "detached"
  }

  export function isReady(owner: BrowserOwner.Info, tabId?: string | null): boolean {
    return Boolean(get(owner, tabId)?.isReady())
  }

  export function waitForReady(
    owner: BrowserOwner.Info,
    tabId?: string | null,
    timeoutMs = 5_000,
  ): Promise<HostConnection> {
    const connection = get(owner, tabId)
    if (connection?.isReady()) return Promise.resolve(connection)
    const key = statusKey(owner, tabId ?? null)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = readyWaiters.get(key)
        waiters?.delete(waiter)
        if (waiters?.size === 0) readyWaiters.delete(key)
        reject(new Error("Browser Host control did not become ready"))
      }, timeoutMs)
      const waiter: ReadyWaiter = { resolve, reject, timer }
      const waiters = readyWaiters.get(key) ?? new Set()
      waiters.add(waiter)
      readyWaiters.set(key, waiters)
    })
  }

  export function markStatus(
    owner: BrowserOwner.Info,
    tabId: string | null | undefined,
    nextStatus: HostStatus,
    options: { traceId?: string; reason?: string } = {},
  ): void {
    const normalizedTabId = tabId ?? null
    const key = statusKey(owner, normalizedTabId)
    statuses.set(key, {
      status: nextStatus,
      tabId: normalizedTabId,
      traceId: options.traceId,
      reason: options.reason,
      updatedAt: Date.now(),
    })
    const event: EventPayload = {
      type: "browser.host.status",
      status: nextStatus,
      tabId: normalizedTabId,
      traceId: options.traceId,
      reason: options.reason,
    }
    emit(owner, event)
    emitGlobal(owner, event)
    if (nextStatus === "ready") resolveReadyWaiters(owner, normalizedTabId)
  }

  export function sessionState(owner: BrowserOwner.Info): BrowserControl.SessionState | null {
    const key = BrowserOwner.key(owner)
    const sessions = [
      ownerHosts.get(key)?.session ?? null,
      ...Array.from(tabHosts.get(key)?.values() ?? []).map((connection) => connection.session),
    ].filter((session): session is BrowserControl.SessionState => Boolean(session))
    if (sessions.length === 0) return null
    return mergeSessions(sessions)
  }

  export async function execute(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
    options: ExecuteOptions = {},
  ): Promise<BrowserControl.Result> {
    const host = resolveHost(owner, command)
    if (!host) throw new BrowserHostControlNotAttachedError()
    return host.execute(command, options)
  }

  export function addObserver(owner: BrowserOwner.Info, listener: (event: EventPayload) => void): () => void {
    const key = BrowserOwner.key(owner)
    const set = observers.get(key) ?? new Set()
    set.add(listener)
    observers.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) observers.delete(key)
    }
  }

  export function addGlobalObserver(listener: (owner: BrowserOwner.Info, event: EventPayload) => void): () => void {
    globalObservers.add(listener)
    return () => {
      globalObservers.delete(listener)
    }
  }

  export function resetForTest(): void {
    for (const connection of ownerHosts.values()) connection.close()
    for (const tabs of tabHosts.values()) {
      for (const connection of tabs.values()) connection.close()
    }
    ownerHosts.clear()
    tabHosts.clear()
    observers.clear()
    statuses.clear()
    for (const waiters of readyWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error("Browser Host control reset"))
      }
    }
    readyWaiters.clear()
    nextRequestId = 1
  }

  function emit(owner: BrowserOwner.Info, event: EventPayload): void {
    const set = observers.get(BrowserOwner.key(owner))
    if (!set) return
    for (const listener of set) listener(event)
  }

  function emitGlobal(owner: BrowserOwner.Info, event: EventPayload): void {
    for (const listener of globalObservers) listener(owner, event)
  }

  function statusKey(owner: BrowserOwner.Info, tabId: string | null): string {
    return tabId ? `${BrowserOwner.key(owner)}:tab:${tabId}` : `${BrowserOwner.key(owner)}:owner`
  }

  function resolveReadyWaiters(owner: BrowserOwner.Info, tabId: string | null): void {
    const key = statusKey(owner, tabId)
    const waiters = readyWaiters.get(key)
    const connection = get(owner, tabId)
    if (!waiters || !connection?.isReady()) return
    readyWaiters.delete(key)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(connection)
    }
  }

  function resolveHost(owner: BrowserOwner.Info, command: BrowserControl.Command): HostConnection | undefined {
    const key = BrowserOwner.key(owner)
    if ("tabId" in command && command.tabId) {
      const tabHost = tabHosts.get(key)?.get(command.tabId)
      if (tabHost) return tabHost
    }
    const ownerHost = ownerHosts.get(key)
    if (ownerHost) return ownerHost
    const session = sessionState(owner)
    if (session?.activeTabId) {
      const activeHost = tabHosts.get(key)?.get(session.activeTabId)
      if (activeHost) return activeHost
    }
    const tabs = tabHosts.get(key)
    if (tabs?.size === 1) return tabs.values().next().value
    return undefined
  }

  function mergeSessions(sessions: BrowserControl.SessionState[]): BrowserControl.SessionState {
    const tabs = new Map<string, BrowserControl.TabState>()
    let activeTabId: string | null = null
    for (const session of sessions) {
      for (const tab of session.tabs) tabs.set(tab.id, tab)
      activeTabId = session.activeTabId ?? activeTabId
    }
    return { tabs: Array.from(tabs.values()), activeTabId }
  }

  function mergeReadySession(
    previous: BrowserControl.SessionState | null,
    incoming: BrowserControl.SessionState,
  ): BrowserControl.SessionState {
    if (!previous) return incoming
    const tabs = new Map(previous.tabs.map((tab) => [tab.id, tab]))
    for (const tab of incoming.tabs) tabs.set(tab.id, tab)
    return {
      tabs: Array.from(tabs.values()),
      activeTabId: incoming.activeTabId ?? previous.activeTabId,
    }
  }
}
