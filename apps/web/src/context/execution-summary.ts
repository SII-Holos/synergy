import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type {
  ExecutionSummary,
  ExecutionProjection,
  EventExecutionUpdated,
  SynergyClient,
} from "@ericsanchezok/synergy-sdk/client"
import { newerExecutionSample } from "../utils/execution-time"

export function createExecutionSummary(input: {
  client: SynergyClient
  sessionID: Accessor<string | undefined>
  available: Accessor<boolean>
  connected: Accessor<boolean>
  visible: Accessor<boolean>
  subscribe: (receive: (event: EventExecutionUpdated["properties"]) => void) => () => void
  projection?: {
    enabled: Accessor<boolean>
    renew: () => void
    subscribe: (receive: (event: ExecutionProjection) => void) => () => void
  }
}) {
  const [state, setState] = createStore<{ summary?: ExecutionSummary; loading: boolean; error: boolean }>({
    loading: false,
    error: false,
  })
  const [connectionVersion, setConnectionVersion] = createSignal(0)
  let request = 0
  let abort: AbortController | undefined
  let requestedSession: string | undefined
  const [fresh, setFresh] = createSignal(false)
  const connected = () => input.connected() && fresh() && input.visible()
  let eventVersion = 0
  const refresh = async () => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.available()) return
    requestedSession = sessionID
    if (input.projection?.enabled() && input.connected()) {
      request++
      abort?.abort()
      setState({ loading: true, error: false })
      input.projection.renew()
      return
    }
    const version = ++request
    const stamp = eventVersion
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    setState({ loading: true, error: false })
    try {
      const response = await input.client.session.executionSummary(
        { sessionID },
        { signal: controller.signal, throwOnError: true },
      )
      if (request !== version || input.sessionID() !== sessionID) return
      if (
        (eventVersion === stamp || newerExecutionSample(state.summary, response.data)) &&
        newerExecutionSample(state.summary, response.data, true)
      ) {
        setFresh(true)
        setState("summary", reconcile(response.data))
      }
    } catch {
      if (request === version && !controller.signal.aborted) setState("error", true)
    } finally {
      if (request === version) setState("loading", false)
    }
  }
  createEffect(
    on([input.sessionID, input.available, input.connected], ([id, enabled, connected], previous) => {
      request++
      abort?.abort()
      setState({ loading: false, error: false })
      if (id !== previous?.[0]) {
        requestedSession = undefined
        setState("summary", undefined)
      }
      setFresh(false)
      if (id && enabled && connected) {
        setConnectionVersion((value) => value + 1)
        if (requestedSession === id && input.visible()) void refresh()
      }
    }),
  )
  const unsubscribe = input.subscribe((next) => {
    if (
      !input.connected() ||
      next.sessionID !== input.sessionID() ||
      !newerExecutionSample(state.summary, next.summary)
    )
      return
    eventVersion++
    setFresh(true)
    setState({ loading: false, error: false })
    setState("summary", reconcile(next.summary))
  })
  const unsubscribeProjection = input.projection?.subscribe((next) => {
    if (!input.connected() || next.sessionID !== input.sessionID() || !input.visible()) return
    if (next.state === "preparing") setState({ loading: true, error: false })
    if (next.state === "failed") {
      setFresh(false)
      setState({ loading: false, error: true })
    }
    if (next.state === "ready") setState({ loading: false, error: false })
  })
  createEffect(
    on(
      input.visible,
      (visible) => {
        if (!visible && state.loading) {
          request++
          abort?.abort()
          setState("loading", false)
          setFresh(false)
          return
        }
        if (visible && input.connected() && !fresh() && !state.loading && requestedSession === input.sessionID())
          void refresh()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    request++
    abort?.abort()
    unsubscribe()
    unsubscribeProjection?.()
  })
  return { state, refresh, connected, connectionVersion }
}
