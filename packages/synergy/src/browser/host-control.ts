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

  const hosts = new Map<string, HostConnection>()
  const observers = new Map<string, Set<(event: EventPayload) => void>>()
  let nextRequestId = 1

  export class HostConnection {
    private pending = new Map<string, PendingRequest>()
    private closed = false
    session: BrowserControl.SessionState | null = null

    constructor(
      readonly owner: BrowserOwner.Info,
      private socket: BrowserHostControlSocket,
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
          this.session = msg.session ?? this.session
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

  export function attach(owner: BrowserOwner.Info, socket: BrowserHostControlSocket): HostConnection {
    BrowserOwner.assertValid(owner)
    const key = BrowserOwner.key(owner)
    hosts.get(key)?.close()
    const connection = new HostConnection(owner, socket)
    hosts.set(key, connection)
    return connection
  }

  export function detach(owner: BrowserOwner.Info, connection: HostConnection): void {
    const key = BrowserOwner.key(owner)
    if (hosts.get(key) !== connection) return
    hosts.delete(key)
    connection.close()
    emit(owner, {
      type: "error",
      severity: "warning",
      code: "browser_host_disconnected",
      message: "Native Browser Host disconnected.",
    })
  }

  export function get(owner: BrowserOwner.Info): HostConnection | undefined {
    return hosts.get(BrowserOwner.key(owner))
  }

  export function has(owner: BrowserOwner.Info): boolean {
    return Boolean(get(owner))
  }

  export function sessionState(owner: BrowserOwner.Info): BrowserControl.SessionState | null {
    return get(owner)?.session ?? null
  }

  export async function execute(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
  ): Promise<BrowserControl.Result> {
    const host = get(owner)
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
    for (const connection of hosts.values()) connection.close()
    hosts.clear()
    observers.clear()
    nextRequestId = 1
  }

  function emit(owner: BrowserOwner.Info, event: EventPayload): void {
    const set = observers.get(BrowserOwner.key(owner))
    if (!set) return
    for (const listener of set) listener(event)
  }
}
