/**
 * Minimal SSE client for the Synergy event stream.
 *
 * The desktop pet subscribes to `GET /event?stream=delta` on the local Synergy
 * server (the top-level bus event stream the Web app also consumes) and
 * forwards bus events to the pet state machine. The endpoint is trusted from
 * loopback, so no token is required for the local desktop runtime.
 *
 * This client is intentionally small: it parses `data:` lines, reconnects with
 * backoff, and stops cleanly. It exposes the raw event objects to the caller.
 */

export interface PetSseEvent {
  type?: string
  properties?: Record<string, unknown>
}

export interface PetSseClientOptions {
  url: string
  onEvent(event: PetSseEvent): void
  onStatus?(status: PetSseStatus): void
  /** Reconnect base delay in ms (default 1000). */
  reconnectBaseMs?: number
  /** Maximum reconnect delay in ms (default 15000). */
  reconnectMaxMs?: number
  /** Injectable fetch for tests (default global fetch). */
  fetch?: typeof fetch
  signal?: AbortSignal
}

export type PetSseStatus = "connecting" | "connected" | "disconnected" | "closed"

export class PetSseClient {
  private readonly url: string
  private readonly onEvent: (event: PetSseEvent) => void
  private readonly onStatus: ((status: PetSseStatus) => void) | undefined
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly fetchImpl: typeof fetch
  private readonly signal: AbortSignal | undefined
  private controller: AbortController | null = null
  private closed = false
  private retryCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private status: PetSseStatus = "disconnected"

  constructor(options: PetSseClientOptions) {
    this.url = options.url
    this.onEvent = options.onEvent
    this.onStatus = options.onStatus
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000
    this.fetchImpl = options.fetch ?? fetch
    this.signal = options.signal
    this.signal?.addEventListener("abort", () => this.close())
  }

  start(): void {
    if (this.closed) return
    void this.connect()
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.controller?.abort()
    this.controller = null
    this.setStatus("closed")
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    this.setStatus("connecting")
    const controller = new AbortController()
    this.controller = controller
    if (this.signal?.aborted) {
      this.close()
      return
    }
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (this.closed) return
      if (!response.ok || !response.body) {
        throw new Error(`SSE request failed with status ${response.status}`)
      }
      this.retryCount = 0
      this.setStatus("connected")
      await this.readStream(response.body, controller.signal)
    } catch (error) {
      if (this.closed || controller.signal.aborted) return
      this.setStatus("disconnected")
      this.scheduleReconnect()
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        if (signal.aborted) return
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "")
          buffer = buffer.slice(newlineIndex + 1)
          this.handleLine(line)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleLine(line: string): void {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trimStart()
    if (!payload) return
    try {
      const parsed = JSON.parse(payload) as PetSseEvent
      this.onEvent(parsed)
    } catch {
      // Ignore malformed frames; the stream self-heals.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.retryCount, this.reconnectMaxMs)
    this.retryCount += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private setStatus(status: PetSseStatus): void {
    if (this.status === status) return
    this.status = status
    this.onStatus?.(status)
  }
}
