import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { selectPromptDockControl } from "./prompt-dock-control-model"
import { SubagentDock } from "./subagent-dock"
import { SessionProgressPanel } from "./session-progress-panel"
import "./prompt-dock-float-layer.css"

export function PromptDockControlSlot(props: { priorityControl?: JSX.Element; fallback?: JSX.Element }) {
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
  const [anchor, setAnchor] = createSignal<HTMLDivElement>()
  const [editorExpanded, setEditorExpanded] = createSignal(false)
  onMount(() => {
    const dock = anchor()?.closest(".session-prompt-dock-content")
    if (!dock) return
    const measure = () => setEditorExpanded(!!dock.querySelector(".session-composer[data-expanded]"))
    const observer = new MutationObserver(measure)
    observer.observe(dock, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-expanded"] })
    measure()
    onCleanup(() => observer.disconnect())
  })
  return (
    <div ref={setAnchor} class="prompt-dock-float-layer relative w-full flex flex-col items-center">
      <SubagentDock sessionID={props.sessionID} suppressed={editorExpanded()} />
      <PromptDockControlSlot priorityControl={props.priorityControl} />
      <SessionProgressPanel
        sessionID={props.sessionID}
        anchor={anchor()}
        suppressed={editorExpanded() || props.priorityControl !== undefined}
      />
    </div>
  )
}
