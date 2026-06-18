import { Show, createMemo } from "solid-js"
import type { DagSummary, TodoSummary } from "./session-progress-summary"
import { formatRailText, formatProgressText } from "./session-progress-summary"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

export interface SessionProgressRailProps {
  mode: "dag" | "todo" | "both"
  dagSummary?: DagSummary
  todoSummary?: TodoSummary
  expanded: boolean
  onClick: () => void
  class?: string
}

export function SessionProgressRail(props: SessionProgressRailProps) {
  const text = createMemo(() => formatRailText(props.mode, props.dagSummary, props.todoSummary))

  const dotColor = createMemo(() => {
    const dag = props.dagSummary
    switch (dag?.attentionLevel) {
      case "failed":
        return "bg-surface-critical-base"
      case "blocked":
        return "bg-surface-warning-base"
      case "running":
        return "bg-surface-interactive-base"
    }
    const todo = props.todoSummary
    if (todo && todo.inProgress > 0) return "bg-surface-interactive-base"
    return "bg-surface-raised-strong-hover"
  })

  const shouldPulse = createMemo(() => {
    const dag = props.dagSummary
    const todo = props.todoSummary
    if (dag && dag.attentionLevel !== "none") return true
    if (todo && todo.inProgress > 0) return true
    return false
  })

  const ariaLabel = createMemo(() => {
    const parts: string[] = []
    if (props.mode !== "todo") {
      const d = props.dagSummary
      if (d && d.total > 0) parts.push(`DAG ${formatProgressText(d.completed, d.total)}`)
    }
    if (props.mode !== "dag") {
      const t = props.todoSummary
      if (t && t.total > 0) parts.push(`Todo ${formatProgressText(t.completed, t.total)}`)
    }
    return parts.length > 0 ? `Session progress: ${parts.join(" · ")}` : "Session progress"
  })

  return (
    <Show when={text()}>
      <button
        type="button"
        class={`absolute -top-4 left-4 flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 py-1 text-11-medium text-text-weak shadow-sm transition-all duration-150 hover:bg-surface-raised-stronger-hover active:scale-[0.98] ${props.class ?? ""}`}
        aria-label={ariaLabel()}
        aria-controls="session-progress-drawer"
        aria-expanded={props.expanded}
        onClick={props.onClick}
      >
        {/* Colored dot: no filled circle icon available in the project icon system */}
        <span
          class={`size-2 shrink-0 rounded-full ${dotColor()} ${shouldPulse() ? "motion-safe:animate-pulse" : ""}`}
        />
        <span class="truncate">{text()}</span>
        <Icon
          name="chevron-down"
          size="small"
          class="shrink-0 transition-transform duration-150"
          classList={{ "rotate-180": props.expanded }}
        />
      </button>
    </Show>
  )
}
