import { Show, type JSX } from "solid-js"
import { SessionProgressPanel } from "./session-progress-panel"
import { SubagentDock } from "./subagent-dock"
import { selectPromptDockControl } from "./prompt-dock-control-model"
import "./prompt-dock-float-layer.css"

export function PromptDockControlSlot(props: { priorityControl?: JSX.Element; fallback: JSX.Element }) {
  const control = () =>
    selectPromptDockControl({
      workflowOfferVisible: props.priorityControl !== undefined,
      sessionProgressVisible: true,
    })

  return (
    <Show when={control() === "workflow_offer"} fallback={props.fallback}>
      <div class="prompt-dock-control-slot">{props.priorityControl}</div>
    </Show>
  )
}

export function PromptDockFloatLayer(props: { sessionID: string; priorityControl?: JSX.Element }) {
  return (
    <div class="prompt-dock-float-layer absolute inset-x-0 bottom-full flex flex-col items-center">
      <SubagentDock sessionID={props.sessionID} />
      <PromptDockControlSlot
        priorityControl={props.priorityControl}
        fallback={<SessionProgressPanel sessionID={props.sessionID} />}
      />
    </div>
  )
}
