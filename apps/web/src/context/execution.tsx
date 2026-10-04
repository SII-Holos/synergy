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
        if (eventVersion === stamp || !state.summary || response.data.revision >= state.summary.revision)
          setState("summary", reconcile(response.data))
      } catch {
        if (request === version && !abort.signal.aborted) setState("error", true)
      } finally {
        if (request === version) setState("loading", false)
      }
    }
    createEffect(
      on([() => params.id, available, sdk.connected], ([id, enabled, connected]) => {
        if (state.summary?.sessionID !== id) setState("summary", undefined)
        if (id && enabled && connected) {
          setConnectionVersion((value) => value + 1)
          void refresh()
        }
      }),
    )
    const unsubscribe = sdk.event.on("execution.updated", (event) => {
      const next = event.properties
      if (next.sessionID !== params.id || next.revision <= (state.summary?.revision ?? -1)) return
      eventVersion++
      setState("summary", reconcile(next.summary))
    })
    onCleanup(() => {
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
      round: (id: string) => rounds().get(id),
      open: (runID?: string, nodeID?: string) =>
        panels.openPanel("context", runID || nodeID ? { init: { state: { runID, nodeID } } } : undefined),
    }
  },
})
