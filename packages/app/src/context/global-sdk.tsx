import { createSynergyClient, type Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }

    let queue: Array<Queued | undefined> = []
    const coalesced = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      const events = queue
      queue = []
      coalesced.clear()
      if (events.length === 0) return

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    let disposed = false
    let ws: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectDelay = 1000

    function connect() {
      if (disposed) return
      const wsUrl = `${server.url}/global/event/ws`
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        reconnectDelay = 1000
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

        const directory = parsed.directory ?? "global"
        const k = key(directory, payload)
        if (k) {
          const i = coalesced.get(k)
          if (i !== undefined) {
            queue[i] = undefined
          }
          coalesced.set(k, queue.length)
        }
        queue.push({ directory, payload })
        schedule()
      }

      socket.onclose = () => {
        if (disposed) return
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000)
          connect()
        }, reconnectDelay)
      }

      socket.onerror = () => {
        socket.close()
      }
    }

    connect()

    onCleanup(() => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      flush()
    })

    const platform = usePlatform()
    const sdk = createSynergyClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter }
  },
})
