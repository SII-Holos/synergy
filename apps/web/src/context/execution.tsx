import { createExecutionContext } from "./execution-context"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { createExecutionSummary } from "./execution-summary"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
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
    const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
    const visibility = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => document.removeEventListener("visibilitychange", visibility))
    const { state, refresh, connected, connectionVersion } = createExecutionSummary({
      client: sdk.client,
      sessionID: () => params.id,
      available,
      connected: sdk.connected,
      visible,
      subscribe: (receive) => sdk.event.on("execution.updated", (event) => receive(event.properties)),
    })
    const advance = createExecutionClock(() => state.summary, connected)
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
