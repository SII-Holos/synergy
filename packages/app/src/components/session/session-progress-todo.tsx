import { createMemo, createSignal, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import type { TodoItem, TodoSummary } from "./session-progress-summary"

interface SessionProgressTodoProps {
  sessionID: string
  summary: TodoSummary
  class?: string
}

function statusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓"
    case "in_progress":
      return "●"
    case "cancelled":
      return "✗"
    default:
      return "○"
  }
}
function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-on-success-base"
    case "in_progress":
      return "text-text-interactive-base"
    case "cancelled":
      return "text-text-weaker"
    default:
      return "text-text-weak"
  }
}
function contentClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-text-weaker"
    case "cancelled":
      return "text-text-weaker line-through"
    default:
      return "text-text-base"
  }
}
function statusLabel(status: string): string | undefined {
  switch (status) {
    case "in_progress":
      return "active"
    case "completed":
      return "done"
    case "cancelled":
      return "skipped"
    default:
      return undefined
  }
}
function labelClass(status: string): string {
  switch (status) {
    case "in_progress":
      return "bg-text-interactive-base/10 text-text-interactive-base ring-1 ring-inset ring-text-interactive-base/12"
    case "completed":
      return "bg-surface-success-base/20 text-on-success-base ring-1 ring-inset ring-border-success-base/15"
    case "cancelled":
      return "workbench-control-surface text-text-weaker ring-1 ring-inset ring-border-weak-base"
    default:
      return ""
  }
}

export function SessionProgressTodo(props: SessionProgressTodoProps) {
  const sync = useSync()
  const todos = createMemo<TodoItem[]>(() => sync.data.todo[props.sessionID] ?? [])

  const summaryParts = createMemo(() => {
    const s = props.summary
    const parts: string[] = []
    if (s.completed > 0) parts.push(`${s.completed} completed`)
    if (s.inProgress > 0) parts.push(`${s.inProgress} active`)
    if (s.pending > 0) parts.push(`${s.pending} pending`)
    return parts
  })

  const [expandedTodoId, setExpandedTodoId] = createSignal<string | undefined>(undefined)
  const toggleTodo = (id: string) => {
    setExpandedTodoId((prev) => (prev === id ? undefined : id))
  }

  return (
    <div class={`flex flex-col min-h-0 ${props.class ?? ""}`}>
      <Show
        when={summaryParts().length > 0}
        fallback={<div class="text-text-weaker text-xs px-2.5 py-1">No active tasks</div>}
      >
        <div class="text-xs text-text-weaker px-2.5 py-1 shrink-0">{summaryParts().join(" · ")}</div>
      </Show>
      <Show when={todos().length > 0}>
        <div class="flex flex-col divide-y divide-border-weak-base/60 overflow-y-auto min-h-0">
          <For each={todos()}>
            {(todo) => {
              const isActive = () => todo.status === "in_progress"
              const isExpanded = () => expandedTodoId() === todo.id && todo.content.length > 40
              return (
                <>
                  <div
                    onClick={() => toggleTodo(todo.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        toggleTodo(todo.id)
                      }
                    }}
                    class="workbench-control-surface-hover flex items-center gap-2 px-2.5 py-1.5 transition-colors cursor-pointer select-none"
                    classList={{ "workbench-selected-surface ring-1 ring-inset ring-border-base/32": isActive() }}
                  >
                    <span
                      class={`shrink-0 text-sm leading-none ${statusClass(todo.status)}`}
                      classList={{ "animate-pulse": isActive() }}
                    >
                      {statusIcon(todo.status)}
                    </span>
                    <span class={`text-xs leading-snug truncate flex-1 min-w-0 ${contentClass(todo.status)}`}>
                      {todo.content}
                    </span>
                    <Show when={todo.priority === "high"}>
                      <span class="shrink-0 size-1.5 rounded-full bg-border-warning-base/70" />
                    </Show>
                    <Show when={statusLabel(todo.status)}>
                      {(label) => (
                        <span class={`shrink-0 text-11-medium px-1.5 py-0.5 rounded-full ${labelClass(todo.status)}`}>
                          {label()}
                        </span>
                      )}
                    </Show>
                  </div>
                  <Show when={isExpanded()}>
                    <div class="workbench-card-surface flex items-center gap-2 px-2.5 py-1.5 border-t border-border-weak-base/40">
                      <span class="shrink-0 text-sm leading-none text-text-weaker"> </span>
                      <span class="text-xs leading-snug text-text-base whitespace-pre-wrap break-words flex-1 min-w-0">
                        {todo.content}
                      </span>
                    </div>
                  </Show>
                </>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
