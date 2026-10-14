import { createPartProjectionStream } from "./part-projection-stream"
import { createViewPatchStream } from "./view-patch-stream"
import { createSynergyClient, type Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup } from "solid-js"
import { createDraftSessionIndex } from "./prompt/draft-index"
import { createEventQueue } from "./event-queue"
import { usePlatform } from "./platform"
import {
  recordTokenReceive,
  recordFrontendWork,
  stopBrowserPerformanceMetrics,
} from "@/components/performance/browser-metrics"
import { useServer } from "./server"
import { streamingTokenReceipt } from "./streaming-token-event"
import { createRuntimeCapabilities, discoverRuntimeCapabilities } from "./runtime-capabilities"
import { createContentSubscriptions, projectContentSummary } from "./content-subscriptions"
import { createSessionPreparationCache } from "./session-preparation-cache"

const PING_INTERVAL = 20_000
const PONG_TIMEOUT = 10_000
const MAX_MISSED_PONGS = 3

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const sdk = createSynergyClient({ baseUrl: server.url, fetch: platform.fetch, throwOnError: true })
    const capabilities = createRuntimeCapabilities((signal) => discoverRuntimeCapabilities(sdk, signal))
    const drafts = createDraftSessionIndex(server.url)
    const sessionPreparation = createSessionPreparationCache()
    onCleanup(() => drafts.dispose())
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const eventQueue = createEventQueue({
      emit: (scopeID, payload) => {
        emitter.emit(scopeID, payload as Event)
        const event = payload as Event
        if (event.type === "message.part.summary") contentSubscriptions.settle(scopeID, event.properties)
      },
      isHidden: () => document.visibilityState === "hidden",
      batch,
      onDrain(count, duration, pending) {
        recordFrontendWork("frontend.events.processed", count, "count")
        recordFrontendWork("frontend.events.drain.duration", duration, "ms", "max")
        recordFrontendWork("frontend.events.pending", pending, "count", "max")
      },
    })

    let disposed = false
    let ws: WebSocket | undefined
    let mode: "projection" | "projection-v2" = "projection"
    let interestsFrame: number | undefined
    const [contentRevision, setContentRevision] = createSignal(0)
    const contentSubscriptions = createContentSubscriptions(
      () => {
        viewPatches?.prune()
        partStreams?.prune()
        if (interestsFrame !== undefined) return
        interestsFrame = requestAnimationFrame(() => {
          interestsFrame = undefined
          if (ws?.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                payload: {
                  type: mode === "projection-v2" ? "client.view.interests" : "client.content.interests",
                  properties: contentSubscriptions.current(),
                },
              }),
            )
        })
      },
      () => setContentRevision((revision) => revision + 1),
    )
    const viewPatches = createViewPatchStream({
      accepts: (scopeID, frame) =>
        contentSubscriptions.acceptsView(scopeID, frame.sessionID, frame.kind, frame.generation),
      read: async (scopeID, frame, signal) => {
        if (frame.kind !== "execution" || !frame.snapshot) throw new Error("Unsupported view checkpoint")
        const response = await sdk.session.executionSummary(
          { scopeID, sessionID: frame.sessionID, projection: frame.snapshot },
          { signal, throwOnError: true },
        )
        const summary = response.data!
        return {
          sessionID: summary.sessionID,
          revision: summary.revision,
          summary,
          roundSummaries: [],
          contextUpserts: [],
          upserts: [],
          processUpserts: [],
          processRemoved: [],
          removed: [],
          previousRevision: summary.revision,
        }
      },
      emit: (scopeID, value, frame) => {
        if (
          frame.kind !== "execution" ||
          !value ||
          typeof value !== "object" ||
          !("summary" in value) ||
          !("sessionID" in value) ||
          value.sessionID !== frame.sessionID
        )
          throw new Error("Invalid execution projection")
        eventQueue.push(scopeID, { type: "execution.updated", properties: value })
        if (frame.snapshot) eventQueue.push(scopeID, { type: "server.view.patch", properties: frame })
      },
      recover: (scopeID, frame) => contentSubscriptions.renewView(scopeID, frame.sessionID, frame.kind),
    })
    const partStreams = createPartProjectionStream({
      accepts: (scopeID, properties) => contentSubscriptions.acceptsSummary(scopeID, properties),
      read: async (scopeID, properties, signal) => {
        if (properties.content?.kind !== "reference") throw new Error("Missing content checkpoint")
        const result = await sdk.session.partContent(
          {
            scopeID,
            sessionID: properties.summary.sessionID,
            messageID: properties.summary.messageID,
            partID: properties.summary.id,
            projection: properties.content.checkpoint,
          },
          { signal, throwOnError: true },
        )
        return result.data!
      },
      emit: (scopeID, incoming) => {
        const properties = projectContentSummary(contentSubscriptions, scopeID, incoming)
        if (properties) {
          const receipt = streamingTokenReceipt({ type: "message.part.summary", properties })
          if (receipt) recordTokenReceive(receipt.part, { delta: receipt.delta })
          eventQueue.push(scopeID, { type: "message.part.summary", properties })
        }
      },
      recover: (scopeID, properties) => contentSubscriptions.renewPart(scopeID, properties),
      discard: (scopeID, incoming) => {
        const properties = projectContentSummary(contentSubscriptions, scopeID, incoming)
        if (properties) eventQueue.push(scopeID, { type: "message.part.summary", properties })
      },
    })
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
      sessionPreparation.clear()
      capabilities.reset()
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
      contentSubscriptions.hidden(document.visibilityState === "hidden")
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

    async function connect() {
      if (disposed) return
      await capabilities.load().catch(() => undefined)
      if (disposed) return
      mode = capabilities.current()?.transports?.projection === "projection-v2" ? "projection-v2" : "projection"
      // Opt into the compact streaming protocol (#350 D1): the server sends
      // `message.part.delta` frames during streaming plus periodic full-part
      // checkpoints, instead of the full accumulated part on every delta.
      const wsUrl = `${server.url}/global/event/ws?stream=${mode}`
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        contentSubscriptions.reconnect()
        reconnectDelay = 1000
        missedPongs = 0
        markConnected()
        startPing()
      }

      socket.onmessage = (msg) => {
        let parsed: { scopeID?: string | null; payload?: Event }
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

        if (typeof type === "string" && /^[a-z.]+$/.test(type) && type.length < 60) {
          recordFrontendWork(`frontend.ws.${type}.frames`, 1, "count")
          recordFrontendWork(`frontend.ws.${type}.bytes`, new TextEncoder().encode(msg.data).byteLength, "bytes")
        }
        if (type === "server.heartbeat") return

        if (payload.type === "server.view.patch") {
          if (typeof parsed.scopeID === "string") void viewPatches.receive(parsed.scopeID, payload.properties)
          return
        }
        if (payload.type === "message.part.summary" && payload.properties.subscription !== undefined) {
          const sequenced = (payload as Event & { seq?: number }).seq !== undefined
          if (sequenced)
            eventQueue.push(parsed.scopeID ?? "global", {
              ...payload,
              properties: { summary: payload.properties.summary },
            })
          void partStreams.receive(parsed.scopeID ?? "global", payload.properties, sequenced)
          return
        }
        if (payload.type === "message.part.summary") {
          const properties = projectContentSummary(
            contentSubscriptions,
            parsed.scopeID ?? "global",
            payload.properties,
            (payload as Event & { seq?: number }).seq,
          )
          if (!properties) return
          payload.properties = properties
        }
        const tokenReceipt = streamingTokenReceipt(payload)
        if (tokenReceipt) recordTokenReceive(tokenReceipt.part, { delta: tokenReceipt.delta })

        if (parsed.scopeID !== null && typeof parsed.scopeID !== "string") return
        eventQueue.push(parsed.scopeID ?? "global", payload)
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
      capabilities.dispose()
      clearPingTimers()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      if (interestsFrame !== undefined) cancelAnimationFrame(interestsFrame)
      viewPatches.dispose()
      partStreams.dispose()
      eventQueue.dispose()
      window.removeEventListener("visibilitychange", handleVisibilityChange)
      stopBrowserPerformanceMetrics()
    })

    return {
      url: server.url,
      client: sdk,
      capabilities,
      event: emitter,
      connected,
      disconnectedAt,
      drafts,
      content: {
        ...contentSubscriptions,
        pending(scopeID: string, sessionID: string) {
          contentRevision()
          return contentSubscriptions.pending(scopeID, sessionID)
        },
      },
      sessionPreparation,
      prepareScopeState(scopes: Parameters<typeof server.scopes.prepare>[0]) {
        server.scopes.prepare(scopes)
        drafts.rebuildDraftSessionIndex()
      },
    }
  },
})
