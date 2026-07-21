import { createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { StatusBarIndicator } from "@/components/status-bar"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { computeCortexStats } from "./session-connection-stats"

interface Props {
  sessionID: string
}

export function SessionCortexIndicator(props: Props) {
  const sync = useSync()

  const stats = createMemo(() => computeCortexStats(sync.data.cortex, props.sessionID))

  return (
    <Show when={stats().active > 0 || stats().completed > 0}>
      <StatusBarIndicator
        icon={getSemanticIcon("cortex.main")}
        value={stats().active}
        secondary={stats().completed > 0 ? stats().completed : undefined}
        iconClass={stats().hasRunning ? "text-text-interactive-base animate-pulse" : undefined}
        valueClass={stats().hasRunning ? "text-text-interactive-base" : undefined}
      />
    </Show>
  )
}
