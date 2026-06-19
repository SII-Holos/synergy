import { createMemo, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProgressCircle } from "@ericsanchezok/synergy-ui/progress-circle"
import { formatProgressIslandLabel, type ProgressIslandSnapshot, type ProgressMode } from "./session-progress-summary"
import "./session-progress-island.css"

interface SessionProgressIslandProps {
  mode: Exclude<ProgressMode, "none">
  snapshot: ProgressIslandSnapshot
  activeLabel?: string
  activeTab: "dag" | "todo"
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onTabChange: (tab: "dag" | "todo") => void
  children: JSX.Element
  class?: string
}

function describeProgress(snapshot: ProgressIslandSnapshot): string {
  if (snapshot.status === "hidden") return "Session progress"
  if (snapshot.status === "complete") return `Session progress complete, ${snapshot.total} tasks done`
  if (snapshot.tone === "failed") return `Session progress needs attention, ${snapshot.failed} failed`
  if (snapshot.tone === "blocked") return `Session progress needs attention, ${snapshot.blocked} blocked`
  return `Session progress, ${snapshot.completed} of ${snapshot.total} tasks complete`
}

function detailText(snapshot: ProgressIslandSnapshot): string | undefined {
  if (snapshot.status === "complete") return undefined
  if (snapshot.tone === "failed" || snapshot.tone === "blocked") return undefined
  if (snapshot.pending > 0) return `${snapshot.pending} waiting`
  return undefined
}

export function SessionProgressIsland(props: SessionProgressIslandProps) {
  let rootRef: HTMLDivElement | undefined

  const label = createMemo(() => formatProgressIslandLabel(props.snapshot, props.activeLabel))
  const percentage = createMemo(() => Math.round(props.snapshot.progressRatio * 100))
  const ariaLabel = createMemo(
    () => `${describeProgress(props.snapshot)}. ${props.expanded ? "Collapse" : "Expand"} details.`,
  )

  const setExpanded = (expanded: boolean) => {
    props.onExpandedChange(expanded)
  }

  onMount(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && props.expanded) setExpanded(false)
    }

    const clickHandler = (event: MouseEvent) => {
      if (!props.expanded || !rootRef) return
      if (!rootRef.contains(event.target as Node)) setExpanded(false)
    }

    document.addEventListener("keydown", keyHandler)
    document.addEventListener("click", clickHandler)

    onCleanup(() => {
      document.removeEventListener("keydown", keyHandler)
      document.removeEventListener("click", clickHandler)
    })
  })

  const tab = (kind: "dag" | "todo") => {
    const selected = () => props.activeTab === kind
    return (
      <button
        type="button"
        class="session-progress-island-tab"
        classList={{ "is-selected": selected() }}
        aria-pressed={selected()}
        onClick={() => props.onTabChange(kind)}
      >
        {kind === "dag" ? "DAG" : "To-do"}
      </button>
    )
  }

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class={`session-progress-island ${props.class ?? ""}`}
      data-expanded={props.expanded ? "true" : "false"}
      data-status={props.snapshot.status}
      data-tone={props.snapshot.tone}
    >
      <div class="session-progress-island-surface statusbar-glass">
        <button
          type="button"
          class="session-progress-island-header"
          aria-label={ariaLabel()}
          aria-controls="session-progress-island-panel"
          aria-expanded={props.expanded}
          onClick={() => setExpanded(!props.expanded)}
        >
          <span class="session-progress-island-indicator" aria-hidden="true">
            <ProgressCircle percentage={percentage()} size={18} strokeWidth={2.5} />
          </span>
          <span class="session-progress-island-title">{label()}</span>
          <Show when={detailText(props.snapshot)}>
            {(detail) => <span class="session-progress-island-detail">{detail()}</span>}
          </Show>
          <Icon
            name="chevron-down"
            size="small"
            class="session-progress-island-chevron"
            classList={{ "is-expanded": props.expanded }}
          />
        </button>

        <Show when={props.expanded}>
          <div id="session-progress-island-panel" class="session-progress-island-panel">
            <div class="session-progress-island-panel-topline">
              <span>Current work</span>
              <span class="text-text-weaker">
                {props.snapshot.completed}/{props.snapshot.total} complete
                <Show when={props.snapshot.status !== "complete"}>
                  {props.snapshot.active > 0
                    ? ` · ${props.snapshot.active} active`
                    : ` · ${props.snapshot.pending} waiting`}
                </Show>
              </span>
            </div>

            <Show when={props.mode === "both"}>
              <div class="session-progress-island-tabs" role="group" aria-label="Progress view">
                {tab("dag")}
                {tab("todo")}
              </div>
            </Show>

            <div class="session-progress-island-body">{props.children}</div>
          </div>
        </Show>
      </div>
    </div>
  )
}
