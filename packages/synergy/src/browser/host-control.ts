import type { BrowserControl } from "./control.js"
import { BrowserOwner } from "./owner.js"

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

export namespace BrowserHostControl {
  export type EventPayload = Record<string, unknown>

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
  }

  const ownerHosts = new Map<string, HostConnection>()
  const tabHosts = new Map<string, Map<string, HostConnection>>()
  const observers = new Map<string, Set<(event: EventPayload) => void>>()
  let nextRequestId = 1

  export interface AttachOptions {
    tabId?: string | null
  }

  export class HostConnection {
    private pending = new Map<string, PendingRequest>()
    private closed = false
    session: BrowserControl.SessionState | null = null

    constructor(
      readonly owner: BrowserOwner.Info,
      private socket: BrowserHostControlSocket,
      readonly tabId: string | null = null,
    ) {}

    execute(command: BrowserControl.Command, timeoutMs = 30_000): Promise<BrowserControl.Result> {
      if (this.closed) throw new Error("Browser Host control connection is closed")
      const id = `browser_host_${nextRequestId++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Browser Host command timed out: ${command.type}`))
        }, timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        this.send({ type: "browser.host.command", id, command })
      })
    }

    handleMessage(input: unknown): void {
      if (typeof input !== "object" || input === null) return
      const msg = input as Message
      switch (msg.type) {
        case "browser.host.ready":
          this.session = msg.session ? mergeReadySession(this.session, msg.session) : this.session
          if (this.session) emit(this.owner, { type: "session.state", ...this.session })
          break
        case "browser.host.session":
          this.session = msg.session
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
            pending.reject(error)
            return
          }
          pending.resolve(msg.result ?? { type: "void" })
          break
        }
      }
    }

    close(): void {
      this.closed = true
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
    const connection = new HostConnection(owner, socket, tabId)
    if (tabId) {
      const tabs = tabHosts.get(key) ?? new Map<string, HostConnection>()
      tabs.get(tabId)?.close()
      tabs.set(tabId, connection)
      tabHosts.set(key, tabs)
      return connection
    }
    ownerHosts.get(key)?.close()
    ownerHosts.set(key, connection)
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
    if (!has(owner)) {
      emit(owner, {
        type: "error",
        severity: "warning",
        code: "browser_host_disconnected",
        message: "Native Browser Host disconnected.",
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
  ): Promise<BrowserControl.Result> {
    const host = resolveHost(owner, command)
    if (!host) throw new Error("Browser Host control is not attached")
    return host.execute(command)
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

  export function resetForTest(): void {
    for (const connection of ownerHosts.values()) connection.close()
    for (const tabs of tabHosts.values()) {
      for (const connection of tabs.values()) connection.close()
    }
    ownerHosts.clear()
    tabHosts.clear()
    observers.clear()
    nextRequestId = 1
  }

  function emit(owner: BrowserOwner.Info, event: EventPayload): void {
    const set = observers.get(BrowserOwner.key(owner))
    if (!set) return
    for (const listener of set) listener(event)
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
