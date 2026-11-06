import { createMemo, Show } from "solid-js"
import { useSessionDataView } from "@/context/session-data-view"
import { StatusBarIndicator } from "@/components/status-bar"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { computeCortexStats } from "./session-connection-stats"

interface Props {
  sessionID: string
}

export function SessionCortexIndicator(props: Props) {
  const view = useSessionDataView()

  const stats = createMemo(() => computeCortexStats(view().cortexTasks(), props.sessionID))

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
