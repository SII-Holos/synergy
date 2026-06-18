import { createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

interface Props {
  sessionID: string
}

export function SessionCortexIndicator(props: Props) {
  const sync = useSync()

  const cortexTasks = createMemo(() => sync.data.cortex.filter((t) => t.parentSessionID === props.sessionID))
  const running = createMemo(() => cortexTasks().filter((t) => t.status === "running").length)
  const queued = createMemo(() => cortexTasks().filter((t) => t.status === "queued").length)
  const completed = createMemo(
    () => cortexTasks().filter((t) => t.status === "completed" || t.status === "error").length,
  )

  const active = createMemo(() => running() + queued())
  const hasRunning = createMemo(() => running() > 0)

  return (
    <Show when={active() > 0 || completed() > 0}>
      <div class="flex items-center gap-1.5 px-2">
        <Icon
          name={getSemanticIcon("connection.cortex")}
          size="small"
          class={hasRunning() ? "text-text-interactive-base animate-pulse" : undefined}
        />
        <span class="text-12-regular text-text-weak">{active()}</span>
        <Show when={completed() > 0}>
          <span class="text-12-regular text-text-subtle">{completed()}</span>
        </Show>
      </div>
    </Show>
  )
}
