import { createExecutionContext } from "./execution-context"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { newerExecutionSample } from "@/utils/execution-time"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "./sdk"
import { useGlobalSDK } from "./global-sdk"
import { useWorkbenchPanels } from "./workbench"

export const { use: useExecution, provider: ExecutionProvider } = createSimpleContext({
  name: "Execution",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const global = useGlobalSDK()
    const panels = useWorkbenchPanels()
    const params = useParams()
    const available = () => global.capabilities.has("workbench")
    const [state, setState] = createStore<{ summary?: ExecutionSummary; loading: boolean; error: boolean }>({
      loading: false,
      error: false,
    })
    const [connectionVersion, setConnectionVersion] = createSignal(0)
    let request = 0
    let abort: AbortController | undefined
    const [fresh, setFresh] = createSignal(false)
    const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
    const connected = () => sdk.connected() && fresh() && visible()
    const advance = createExecutionClock(() => state.summary, connected)
    let eventVersion = 0
    const refresh = async () => {
      const sessionID = params.id
      if (!sessionID || !available()) return
      const version = ++request
      const stamp = eventVersion
      abort?.abort()
      abort = new AbortController()
      setState({ loading: true, error: false })
      try {
        const response = await sdk.client.session.executionSummary(
          { sessionID },
          { signal: abort.signal, throwOnError: true },
        )
        if (request !== version || params.id !== sessionID) return
        if (
          (eventVersion === stamp || newerExecutionSample(state.summary, response.data)) &&
          newerExecutionSample(state.summary, response.data, true)
        ) {
          setFresh(true)
          setState("summary", reconcile(response.data))
        }
      } catch {
        if (request === version && !abort.signal.aborted) setState("error", true)
      } finally {
        if (request === version) setState("loading", false)
      }
    }
    createEffect(
      on([() => params.id, available, sdk.connected], ([id, enabled, connected]) => {
        if (state.summary?.sessionID !== id) setState("summary", undefined)
        setFresh(false)
        if (id && enabled && connected) {
          setConnectionVersion((value) => value + 1)
          void refresh()
        }
      }),
    )
    const unsubscribe = sdk.event.on("execution.updated", (event) => {
      const next = event.properties
      if (!sdk.connected() || next.sessionID !== params.id || !newerExecutionSample(state.summary, next.summary)) return
      eventVersion++
      setFresh(true)
      setState("summary", reconcile(next.summary))
    })
    const visibility = () => {
      setVisible(document.visibilityState !== "hidden")
      setFresh(false)
      if (document.visibilityState === "visible" && sdk.connected()) {
        setConnectionVersion((value) => value + 1)
        void refresh()
      }
    }
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", visibility)
      request++
      abort?.abort()
      unsubscribe()
    })
    const rounds = createMemo(() => new Map(state.summary?.rounds.map((round) => [round.id, round]) ?? []))
    return {
      state,
      refresh,
      available,
      connectionVersion,
      advance,
      connected,
      createContextHistory: (
        options: Pick<Parameters<typeof createExecutionContext>[0], "runID" | "active" | "selected">,
      ) =>
        createExecutionContext({
          ...options,
          client: sdk.client,
          sessionID: () => params.id,
          connectionVersion,
          subscribe: (receive) => sdk.event.on("execution.updated", (event) => receive(event.properties)),
        }),
      round: (id: string) => {
        const round = rounds().get(id)
        return round
          ? {
              ...round,
              elapsedMs: round.elapsedMs == null ? null : round.elapsedMs + (round.elapsedActive ? advance() : 0),
            }
          : undefined
      },
      open: (runID?: string, nodeID?: string) =>
        panels.openPanel("context", runID || nodeID ? { init: { state: { runID, nodeID } } } : undefined),
    }
  },
})
