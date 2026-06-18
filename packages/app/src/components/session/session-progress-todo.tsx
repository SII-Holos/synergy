import { createMemo, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { computeTodoSummary, type TodoItem } from "./session-progress-summary"

interface SessionProgressTodoProps {
  sessionID: string
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
      return "text-success"
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
      return "bg-surface-success-base/20 text-success ring-1 ring-inset ring-success/15"
    case "cancelled":
      return "bg-surface-raised-stronger text-text-weaker ring-1 ring-inset ring-border-weak-base"
    default:
      return ""
  }
}

export function SessionProgressTodo(props: SessionProgressTodoProps) {
  const sync = useSync()

  const todos = createMemo<TodoItem[]>(() => sync.data.todo[props.sessionID] ?? [])

  const summary = createMemo(() => computeTodoSummary(todos()))

  const summaryParts = createMemo(() => {
    const s = summary()
    const parts: string[] = []
    if (s.completed > 0) parts.push(`${s.completed} completed`)
    if (s.inProgress > 0) parts.push(`${s.inProgress} active`)
    if (s.pending > 0) parts.push(`${s.pending} pending`)
    return parts
  })

  return (
    <div class={`flex flex-col min-h-0 ${props.class ?? ""}`}>
      {/* Header */}
      <Show
        when={summaryParts().length > 0}
        fallback={<div class="text-text-weaker text-xs px-3 py-1.5">No active tasks</div>}
      >
        <div class="text-xs text-text-weaker px-3 py-1.5 shrink-0">{summaryParts().join(" · ")}</div>
      </Show>

      {/* List */}
      <Show when={todos().length > 0}>
        <div class="flex flex-col divide-y divide-border-weak-base/60 overflow-y-auto min-h-0">
          <For each={todos()}>
            {(todo) => {
              const isActive = () => todo.status === "in_progress"
              return (
                <div
                  class="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-raised-base-hover"
                  classList={{
                    "bg-text-interactive-base/5 border-l-2 border-l-text-interactive-base": isActive(),
                  }}
                >
                  {/* Status icon */}
                  <span
                    class={`shrink-0 text-sm leading-none ${statusClass(todo.status)}`}
                    classList={{ "animate-pulse": isActive() }}
                  >
                    {statusIcon(todo.status)}
                  </span>

                  {/* Content */}
                  <span class={`text-xs leading-snug truncate flex-1 min-w-0 ${contentClass(todo.status)}`}>
                    {todo.content}
                  </span>

                  {/* Priority */}
                  <Show when={todo.priority === "high"}>
                    <span class="shrink-0 size-1.5 rounded-full bg-text-warning-base/70" />
                  </Show>

                  {/* Status label */}
                  <Show when={statusLabel(todo.status)}>
                    {(label) => (
                      <span class={`shrink-0 text-11-medium px-1.5 py-0.5 rounded-full ${labelClass(todo.status)}`}>
                        {label()}
                      </span>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
