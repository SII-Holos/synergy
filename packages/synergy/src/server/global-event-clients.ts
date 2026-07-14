import type { WSContext } from "hono/ws"
import { Log } from "../util/log"

export namespace GlobalEventClients {
  const log = Log.create({ service: "server.global-event-clients" })

  export type Mode = "full" | "delta"
  export type SendResult = "sent" | "backpressured" | "dropped" | "closed" | "error"

  export interface ClientState {
    mode: Mode
    ws: WSContext
    raw?: unknown
    connectedAt: number
    lastSendAt?: number
    lastBackpressureAt?: number
    consecutiveBackpressure: number
    droppedFrames: number
    sentFrames: number
  }

  export interface RegistryOptions {
    /** Max consecutive backpressure results before the client is closed. */
    maxConsecutiveBackpressure?: number
    /** If raw.bufferedAmount exceeds this, treat as backpressure. */
    bufferedAmountLimit?: number
    now?: () => number
  }

  export interface Registry {
    size(): number
    add(ws: WSContext, mode: Mode): void
    remove(ws: WSContext): boolean
    broadcast(encode: (mode: Mode) => string): {
      clients: number
      sent: number
      dropped: number
      removed: number
    }
    heartbeat(data: string): {
      clients: number
      sent: number
      removed: number
    }
    clear(): void
    clients(): IterableIterator<ClientState>
  }

  export function connectionKey(ws: WSContext): unknown {
    // Hono's Bun adapter constructs a fresh WSContext wrapper per callback while
    // keeping the underlying ServerWebSocket (`ws.raw`) stable. Prefer raw as the
    // identity so open/close/error/message share one registry entry.
    return (ws as { raw?: unknown }).raw ?? ws
  }

  export function createRegistry(options: RegistryOptions = {}): Registry {
    const maxConsecutiveBackpressure = options.maxConsecutiveBackpressure ?? 32
    const bufferedAmountLimit = options.bufferedAmountLimit ?? 8 * 1024 * 1024
    const now = options.now ?? Date.now
    const clients = new Map<unknown, ClientState>()

    function add(ws: WSContext, mode: Mode) {
      const key = connectionKey(ws)
      const existing = clients.get(key)
      if (existing) {
        existing.ws = ws
        existing.mode = mode
        existing.raw = (ws as { raw?: unknown }).raw
        return
      }
      clients.set(key, {
        mode,
        ws,
        raw: (ws as { raw?: unknown }).raw,
        connectedAt: now(),
        consecutiveBackpressure: 0,
        droppedFrames: 0,
        sentFrames: 0,
      })
    }

    function remove(ws: WSContext): boolean {
      return clients.delete(connectionKey(ws))
    }

    function rawReadyState(client: ClientState): number | undefined {
      const raw = client.raw as { readyState?: number } | undefined
      if (raw && typeof raw.readyState === "number") return raw.readyState
      // Hono snapshots readyState into WSContext construction options, so the
      // wrapper value can be stale. Prefer raw when present.
      try {
        return client.ws.readyState
      } catch {
        return undefined
      }
    }

    function rawBufferedAmount(client: ClientState): number | undefined {
      const raw = client.raw as { bufferedAmount?: number } | undefined
      return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : undefined
    }

    function send(client: ClientState, data: string): SendResult {
      const readyState = rawReadyState(client)
      // 1 = OPEN in both browser and Bun ServerWebSocket conventions.
      if (readyState !== undefined && readyState !== 1) return "closed"

      const bufferedAmount = rawBufferedAmount(client)
      if (bufferedAmount !== undefined && bufferedAmount > bufferedAmountLimit) {
        client.consecutiveBackpressure++
        client.lastBackpressureAt = now()
        client.droppedFrames++
        return "backpressured"
      }

      try {
        const raw = client.raw as { send?: (data: string) => number | void } | undefined
        if (raw && typeof raw.send === "function") {
          const result = raw.send(data)
          // Bun documents: -1 backpressure, 0 dropped/closed, >0 bytes sent.
          if (typeof result === "number") {
            if (result < 0) {
              client.consecutiveBackpressure++
              client.lastBackpressureAt = now()
              client.droppedFrames++
              return "backpressured"
            }
            if (result === 0) {
              client.droppedFrames++
              return "dropped"
            }
            client.consecutiveBackpressure = 0
            client.sentFrames++
            client.lastSendAt = now()
            return "sent"
          }
        }

        client.ws.send(data)
        client.consecutiveBackpressure = 0
        client.sentFrames++
        client.lastSendAt = now()
        return "sent"
      } catch {
        return "error"
      }
    }

    function maybeEvict(key: unknown, client: ClientState, result: SendResult): boolean {
      if (result === "closed" || result === "error" || result === "dropped") {
        clients.delete(key)
        return true
      }
      if (result === "backpressured" && client.consecutiveBackpressure >= maxConsecutiveBackpressure) {
        try {
          client.ws.close(1013, "websocket backpressure")
        } catch {}
        clients.delete(key)
        log.warn("evicted websocket client under backpressure", {
          consecutiveBackpressure: client.consecutiveBackpressure,
          droppedFrames: client.droppedFrames,
          mode: client.mode,
        })
        return true
      }
      return false
    }

    function broadcast(encode: (mode: Mode) => string) {
      let sent = 0
      let dropped = 0
      let removed = 0
      // Cache encodings once per mode for this event.
      let fullData: string | undefined
      let deltaData: string | undefined
      const payloadFor = (mode: Mode) => {
        if (mode === "full") {
          fullData ??= encode("full")
          return fullData
        }
        deltaData ??= encode("delta")
        return deltaData
      }

      for (const [key, client] of clients) {
        const result = send(client, payloadFor(client.mode))
        if (result === "sent") sent++
        else dropped++
        if (maybeEvict(key, client, result)) removed++
      }
      return { clients: clients.size + removed, sent, dropped, removed }
    }

    function heartbeat(data: string) {
      let sent = 0
      let removed = 0
      for (const [key, client] of clients) {
        const result = send(client, data)
        if (result === "sent") sent++
        if (maybeEvict(key, client, result === "backpressured" ? "sent" : result)) {
          // Heartbeats should not count toward streaming backpressure eviction.
          // Only hard failures remove clients here.
          if (result !== "backpressured") removed++
        } else if (result === "backpressured") {
          // Reset consecutive counter growth from heartbeats alone.
          client.consecutiveBackpressure = Math.max(0, client.consecutiveBackpressure - 1)
        }
      }
      return { clients: clients.size + removed, sent, removed }
    }

    return {
      size: () => clients.size,
      add,
      remove,
      broadcast,
      heartbeat,
      clear: () => clients.clear(),
      clients: () => clients.values(),
    }
  }
}
