import { createSynergyClient, type Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup } from "solid-js"
import { createEventQueue } from "./event-queue"
import { usePlatform } from "./platform"
import {
  recordTokenReceive,
  startBrowserPerformanceMetrics,
  stopBrowserPerformanceMetrics,
} from "@/components/performance/browser-metrics"
import { useServer } from "./server"
import { streamingTokenReceipt } from "./streaming-token-event"

const PING_INTERVAL = 20_000
const PONG_TIMEOUT = 10_000
const MAX_MISSED_PONGS = 3

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const eventQueue = createEventQueue({
      emit: (directory, payload) => emitter.emit(directory, payload as Event),
      isHidden: () => document.visibilityState === "hidden",
      batch,
    })

    let disposed = false
    let ws: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectDelay = 1000
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let missedPongs = 0
    const [connected, setConnected] = createSignal(false)
    // undefined = initial state (never connected yet)
    // number   = timestamp when the connection was last lost
    const [disconnectedAt, setDisconnectedAt] = createSignal<number | undefined>(undefined)

    const markConnected = () => {
      setConnected(true)
      setDisconnectedAt(undefined)
    }

    const markDisconnected = () => {
      setConnected(false)
      setDisconnectedAt(Date.now())
    }

    const clearPingTimers = () => {
      if (pingTimer) clearInterval(pingTimer)
      if (pongTimer) clearTimeout(pongTimer)
      pingTimer = undefined
      pongTimer = undefined
      missedPongs = 0
    }

    const sendPing = () => {
      const socket = ws
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      try {
        socket.send(JSON.stringify({ payload: { type: "client.ping", properties: {} } }))
      } catch {
        return
      }
      pongTimer = setTimeout(() => {
        missedPongs++
        if (missedPongs >= MAX_MISSED_PONGS) {
          socket.close()
        }
      }, PONG_TIMEOUT)
    }

    const startPing = () => {
      clearPingTimers()
      pingTimer = setInterval(sendPing, PING_INTERVAL)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearPingTimers()
      } else {
        // Apply any events queued while hidden immediately on return to the
        // foreground instead of waiting for the next 1 s cadence tick.
        eventQueue.flush()
        startPing()
        sendPing()
      }
    }
    window.addEventListener("visibilitychange", handleVisibilityChange)

    function connect() {
      if (disposed) return
      // Opt into the compact streaming protocol (#350 D1): the server sends
      // `message.part.delta` frames during streaming plus periodic full-part
      // checkpoints, instead of the full accumulated part on every delta.
      const wsUrl = `${server.url}/global/event/ws?stream=delta`
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        reconnectDelay = 1000
        missedPongs = 0
        markConnected()
        startPing()
      }

      socket.onmessage = (msg) => {
        let parsed: { directory?: string; payload?: Event }
        try {
          parsed = JSON.parse(msg.data)
        } catch {
          return
        }
        const payload = parsed.payload
        if (!payload) return

        const type = payload.type as string
        if (type === "server.pong") {
          if (pongTimer) clearTimeout(pongTimer)
          pongTimer = undefined
          missedPongs = 0
          return
        }

        if (type === "server.heartbeat") return

        const tokenReceipt = streamingTokenReceipt(payload)
        if (tokenReceipt) recordTokenReceive(tokenReceipt.part, { delta: tokenReceipt.delta })

        const directory = parsed.directory ?? "global"
        eventQueue.push(directory, payload)
      }

      socket.onclose = () => {
        clearPingTimers()
        markDisconnected()
        if (disposed) return
        // Apply ±50% jitter to avoid thundering-herd reconnections.
        const jittered = reconnectDelay * (0.5 + Math.random())
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000)
          connect()
        }, jittered)
      }

      socket.onerror = () => {
        socket.close()
      }
    }

    connect()

    onCleanup(() => {
      disposed = true
      clearPingTimers()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      eventQueue.dispose()
      window.removeEventListener("visibilitychange", handleVisibilityChange)
      stopBrowserPerformanceMetrics()
    })

    const platform = usePlatform()
    const sdk = createSynergyClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    startBrowserPerformanceMetrics({ url: server.url, client: sdk })

    return { url: server.url, client: sdk, event: emitter, connected, disconnectedAt }
  },
})
