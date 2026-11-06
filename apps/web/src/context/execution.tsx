import { useViewActivity } from "./view-residency"
import { createExecutionContext } from "./execution-context"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { createExecutionSummary } from "./execution-summary"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { useParams } from "@/context/session-route"
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
    const active = useViewActivity()
    const [consumers, setConsumers] = createSignal(0)
    const [restored, setRestored] = createSignal(0)
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
      visible: () => visible() && active() && consumers() > 0,
      subscribe: (receive) => sdk.event.on("execution.updated", (event) => receive(event.properties)),
      projection: {
        enabled: () => global.capabilities.current?.()?.transports?.viewDemand === 1,
        renew: () => {
          if (params.id) global.content.renewView(sdk.scopeID, params.id, "execution")
        },
        subscribe: (receive) => sdk.event.on("execution.projection", (event) => receive(event.properties)),
      },
    })
    const advance = createExecutionClock(() => state.summary, connected)
    const currentConnection = () => connectionVersion() + restored()
    onCleanup(
      sdk.event.on("server.view.patch", (event) => {
        if (event.properties.sessionID === params.id && event.properties.snapshot) setRestored((value) => value + 1)
      }),
    )
    const retain = (options?: {
      demand?: "root" | "summary" | "trajectory"
      active?: Accessor<boolean>
      runID?: Accessor<string | undefined>
      nodeIDs?: Accessor<string[]>
    }) => {
      const panelActive = useViewActivity()
      const consuming = () =>
        active() && panelActive() && visible() && !!params.id && available() && options?.active?.() !== false
      createEffect(() => {
        const sessionID = params.id
        if (!consuming() || !sessionID) return
        const release = global.content.view({
          kind: "execution",
          scopeID: sdk.scopeID,
          sessionID,
          runID: options?.runID?.(),
          nodeIDs: options?.nodeIDs?.(),
          demands: [options?.demand ?? "summary"],
        })
        if (options?.demand !== "root") setConsumers((value) => value + 1)
        onCleanup(() => {
          release()
          if (options?.demand !== "root") setConsumers((value) => value - 1)
        })
      })
      return consuming
    }
    const rounds = createMemo(() => new Map(state.summary?.rounds.map((round) => [round.id, round]) ?? []))
    return {
      state,
      refresh,
      available,
      connectionVersion,
      retain,
      advance,
      connected,
      createContextHistory: (
        options: Pick<Parameters<typeof createExecutionContext>[0], "runID" | "active" | "selected">,
      ) => {
        const consuming = retain({ active: options.active, runID: options.runID, demand: "root" })
        return createExecutionContext({
          ...options,
          active: consuming,
          client: sdk.client,
          scopeID: () => sdk.scopeID,
          sessionID: () => params.id,
          connectionVersion: currentConnection,
          subscribe: (receive) => {
            const legacy = sdk.event.on("execution.updated", (event) => {
              if (global.capabilities.current?.()?.transports?.viewDemand !== 1) receive(event.properties)
            })
            const root = sdk.event.on("execution.projection", (event) =>
              receive({
                sessionID: event.properties.sessionID,
                revision: event.properties.revision,
                contextUpserts: event.properties.contexts,
                total: event.properties.contextTotal,
              }),
            )
            return () => {
              legacy()
              root()
            }
          },
        })
      },
      round: (id: string) => {
        const round = rounds().get(id)
        return round
          ? {
              ...round,
              elapsedMs: round.elapsedMs == null ? null : round.elapsedMs + (round.elapsedActive ? advance() : 0),
            }
          : undefined
      },
      openTrajectory: (runID?: string, nodeID?: string) =>
        panels.openPanel("trajectory", runID || nodeID ? { init: { state: { runID, nodeID } } } : undefined),
      open: (runID?: string, nodeID?: string) =>
        panels.openPanel("context", runID || nodeID ? { init: { state: { runID, nodeID } } } : undefined),
    }
  },
})
