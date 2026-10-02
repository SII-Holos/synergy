import { createMemo, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSessionDataView } from "@/context/session-data-view"

const statusCopy = {
  completed: { id: "session.todo.completed", message: "Completed" },
  in_progress: { id: "session.todo.inProgress", message: "In progress" },
  pending: { id: "session.todo.pending", message: "Pending" },
  cancelled: { id: "session.todo.cancelled", message: "Cancelled" },
  unknown: { id: "session.todo.unknown", message: "Unknown status" },
}
const priorityCopy = {
  high: { id: "session.todo.priorityHigh", message: "High priority" },
  low: { id: "session.todo.priorityLow", message: "Low priority" },
}

export function SessionProgressTodo(props: { sessionID: string; class?: string }) {
  const view = useSessionDataView()
  const { _ } = useLingui()
  const todos = createMemo(() => view().todosFor(props.sessionID))
  const statusLabel = (value: string) => {
    switch (value) {
      case "completed":
        return _(statusCopy.completed)
      case "in_progress":
        return _(statusCopy.in_progress)
      case "cancelled":
        return _(statusCopy.cancelled)
      case "pending":
        return _(statusCopy.pending)
      default:
        return _(statusCopy.unknown)
    }
  }
  return (
    <ul class={`session-progress-todo-list ${props.class ?? ""}`}>
      <For each={todos()}>
        {(todo) => (
          <li class="session-progress-todo-row" data-status={todo.status}>
            <span class="session-progress-todo-icon" role="img" aria-label={statusLabel(todo.status)}>
              <Icon
                name={getSemanticIcon(
                  todo.status === "completed"
                    ? "state.complete"
                    : todo.status === "cancelled"
                      ? "state.cancelled"
                      : todo.status === "in_progress"
                        ? "session.running"
                        : "state.empty",
                )}
                size="small"
              />
            </span>
            <span class="session-progress-todo-content">{todo.content}</span>
            <Show when={todo.priority === "high" || todo.priority === "low"}>
              <span class="session-progress-todo-priority">
                {_(todo.priority === "high" ? priorityCopy.high : priorityCopy.low)}
              </span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}
