import { createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"

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

  return (
    <Show when={running() > 0 || queued() > 0 || completed() > 0}>
      <div class="flex items-center gap-3">
        <Show when={running() > 0 || queued() > 0}>
          <div class="flex items-center gap-1">
            <Show when={running() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base animate-pulse" />
            </Show>
            <span class="text-12-regular text-text-weak">
              {running() > 0 ? `${running()} running` : ""}
              {running() > 0 && queued() > 0 ? " · " : ""}
            </span>
            <Show when={queued() > 0}>
              <span class="text-12-regular text-text-subtle">{queued()} queued</span>
            </Show>
          </div>
        </Show>
        <Show when={completed() > 0}>
          <div class="flex items-center gap-1">
            <div class="size-1.5 rounded-full bg-icon-success-base" />
            <span class="text-12-regular text-text-weak">{completed()} done</span>
          </div>
        </Show>
      </div>
    </Show>
  )
}
