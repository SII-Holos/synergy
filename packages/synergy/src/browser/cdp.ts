const CDP_TIMEOUT_MS = 30_000

interface CdpRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface CdpResponse {
  id?: number
  result?: unknown
  sessionId?: string
  error?: { code: number; message: string; data?: unknown }
  method?: string
  params?: Record<string, unknown>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class ConnectionImpl implements CdpClient.Connection {
  readonly connected: boolean = true
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  constructor(ws: WebSocket) {
    this.ws = ws

    ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string)
    })

    ws.addEventListener("close", () => {
      this.shutdown(new Error("Connection closed"))
    })

    ws.addEventListener("error", () => {
      this.shutdown(new Error("WebSocket error"))
    })
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (!this.connected) {
      return Promise.reject(new Error("Connection closed"))
    }

    const id = this.nextId++
    const request: CdpRequest = { id, method }
    if (params !== undefined) request.params = params
    if (sessionId !== undefined) request.sessionId = sessionId

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending) {
          this.pending.delete(id)
          pending.reject(new Error(`CDP request timed out after ${CDP_TIMEOUT_MS}ms: ${method}`))
        }
      }, CDP_TIMEOUT_MS)
      timer.unref?.()

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.ws.send(JSON.stringify(request))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  on(event: string, handler: (params: Record<string, unknown>) => void, sessionId?: string): void {
    const handlerKey = sessionId ? `${event}:${sessionId}` : event
    let set = this.handlers.get(handlerKey)
    if (!set) {
      set = new Set()
      this.handlers.set(handlerKey, set)
    }
    set.add(handler)
  }

  off(event: string, handler: (params: Record<string, unknown>) => void, sessionId?: string): void {
    const handlerKey = sessionId ? `${event}:${sessionId}` : event
    this.handlers.get(handlerKey)?.delete(handler)
  }

  async close(): Promise<void> {
    this.shutdown(new Error("Connection closed"))
  }

  private handleMessage(raw: string): void {
    let parsed: CdpResponse
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if ("id" in parsed && typeof parsed.id === "number") {
      this.handleResponse(parsed)
    } else if ("method" in parsed && typeof parsed.method === "string") {
      this.handleEvent(parsed)
    }
  }

  private handleResponse(response: CdpResponse): void {
    const pending = this.pending.get(response.id!)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(response.id!)

    if (response.error) {
      pending.reject(new Error(`CDP error: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleEvent(event: CdpResponse): void {
    const params = event.params ?? {}
    const sessionId = event.sessionId

    // Dispatch to session-scoped handlers first, then global handlers
    if (sessionId) {
      const sessionKey = `${event.method!}:${sessionId}`
      const sessionSet = this.handlers.get(sessionKey)
      if (sessionSet) {
        for (const handler of sessionSet) {
          try {
            handler(params)
          } catch {
            // silently ignore handler errors
          }
        }
      }
    }

    // Dispatch to global handlers (no sessionId filter)
    const globalSet = this.handlers.get(event.method!)
    if (!globalSet) return

    for (const handler of globalSet) {
      try {
        handler(params)
      } catch {
        // silently ignore handler errors
      }
    }
  }

  private shutdown(err: Error): void {
    if (!this.connected) return
    ;(this as { connected: boolean }).connected = false

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
    this.handlers.clear()

    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
    } catch {
      // ignore close errors during shutdown
    }
  }
}

export namespace CdpClient {
  export interface Connection {
    /** Send a CDP command and await response. Auto-assigns id. */
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>

    /** Register event handler. */
    on(event: string, handler: (params: Record<string, unknown>) => void, sessionId?: string): void

    /** Remove event handler. */
    off(event: string, handler: (params: Record<string, unknown>) => void, sessionId?: string): void

    /** Close the connection. */
    close(): Promise<void>

    /** Whether the connection is still open. */
    readonly connected: boolean
  }

  /** Connect via WebSocket to a CDP debugger URL. */
  export function connectWS(wsURL: string): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      const ws = new WebSocket(wsURL)
      let settled = false

      ws.addEventListener("open", () => {
        if (settled) return
        settled = true
        resolve(new ConnectionImpl(ws))
      })

      ws.addEventListener("close", () => {
        if (settled) return
        settled = true
        reject(new Error("WebSocket connection failed"))
      })

      ws.addEventListener("error", () => {
        if (settled) return
        settled = true
        reject(new Error("WebSocket connection error"))
      })
    })
  }

  /** Discover debugger targets from HTTP endpoint http://127.0.0.1:{port}/json. */
  export function discoverTargets(
    httpPort: number,
  ): Promise<{ webSocketDebuggerUrl: string; id: string; title: string; url: string; type: string }[]> {
    return fetch(`http://127.0.0.1:${httpPort}/json`).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to discover targets: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as {
        webSocketDebuggerUrl: string
        id: string
        title: string
        url: string
        type: string
      }[]
    })
  }
}
