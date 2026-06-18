import { Show, onMount, onCleanup, type JSX } from "solid-js"

import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { formatRailText } from "./session-progress-summary"
import type { DagSummary, TodoSummary } from "./session-progress-summary"

interface SessionProgressDrawerProps {
  mode: "dag" | "todo" | "both"
  activeTab: "dag" | "todo"
  onTabChange: (tab: "dag" | "todo") => void
  onClose: () => void
  dagSummary?: DagSummary
  todoSummary?: TodoSummary
  children: JSX.Element
  class?: string
}

function footerText(dag: DagSummary): string {
  const parts: string[] = []
  if (dag.blocked > 0) parts.push(`${dag.blocked} blocked`)
  if (dag.failed > 0) parts.push(`${dag.failed} failed`)
  return parts.join(" · ")
}

export function SessionProgressDrawer(props: SessionProgressDrawerProps) {
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const showFooter = () =>
    props.mode !== "todo" && props.dagSummary != null && (props.dagSummary.blocked > 0 || props.dagSummary.failed > 0)

  const railText = () => formatRailText(props.mode, props.dagSummary, props.todoSummary)

  const tab = (kind: "dag" | "todo") => {
    const isActive = () => props.activeTab === kind
    return (
      <button
        type="button"
        class="rounded-full px-2 py-0.5 text-xs transition-colors"
        classList={{
          "bg-surface-interactive-solid text-text-on-interactive-base": isActive(),
          "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !isActive(),
        }}
        onClick={() => props.onTabChange(kind)}
      >
        {kind === "dag" ? "DAG" : "To-do"}
      </button>
    )
  }

  return (
    <div
      class={`flex flex-col rounded-2xl bg-surface-raised-stronger-non-alpha border border-border-base shadow-sm overflow-hidden ${props.class ?? ""}`}
      style={{
        "max-height": "min(52vh, 560px)",
        "min-height": "280px",
      }}
    >
      {/* Header */}
      <div class="shrink-0 flex items-center justify-between px-4 h-11 gap-2">
        <div class="flex items-baseline gap-1.5 min-w-0">
          <span class="text-xs text-text-weak shrink-0">Current work</span>
          <Show when={railText()}>
            <span class="text-xs text-text-subtle truncate">{railText()}</span>
          </Show>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <Show when={props.mode === "both"}>
            <div class="flex items-center gap-1">
              {tab("dag")}
              {tab("todo")}
            </div>
          </Show>

          <button
            type="button"
            class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={props.onClose}
          >
            <Icon name="x" size="small" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div class="flex-1 min-h-0">{props.children}</div>

      {/* Footer */}
      <Show when={showFooter()}>
        <div class="shrink-0 px-4 py-2 text-xs text-text-weaker border-t border-border-weaker-base/60">
          {footerText(props.dagSummary!)}
        </div>
      </Show>
    </div>
  )
}
