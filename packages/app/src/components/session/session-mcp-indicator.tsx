import { createMemo, Show } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSync } from "@/context/sync"
import { StatusBarIndicator } from "@/components/status-bar-indicator"
import { DialogSelectMcp } from "@/components/dialog"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { computeMcpStats } from "./session-connection-stats"

export function SessionMcpIndicator() {
  const sync = useSync()
  const dialog = useDialog()

  const stats = createMemo(() => computeMcpStats(sync.data.mcp))

  return (
    <Show when={stats().total > 0}>
      <StatusBarIndicator
        icon={getSemanticIcon("connection.mcp")}
        value={stats().enabled}
        onClick={() => dialog.show(() => <DialogSelectMcp />)}
        iconClass={stats().failed ? "text-icon-critical-base" : undefined}
      />
    </Show>
  )
}
