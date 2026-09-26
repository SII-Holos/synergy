import { useLingui } from "@lingui/solid"
import { createMemo, Show } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSync } from "@/context/sync"
import { StatusBarIndicator } from "@/components/status-bar"
import { DialogSelectMcp } from "@/components/dialog"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { computeMcpStats } from "./session-connection-stats"

export function SessionMcpIndicator() {
  const sync = useSync()
  const dialog = useDialog()
  const { _ } = useLingui()

  const stats = createMemo(() => computeMcpStats(sync.data.mcp))

  return (
    <Show when={stats().total > 0}>
      <StatusBarIndicator
        icon={getSemanticIcon("mcp.main")}
        value={stats().enabled}
        tooltip={_({
          id: "session.mcp.status",
          message: "MCP: {enabled} of {total} connected{failed, select, true {; connection errors} other {}}",
          values: { enabled: stats().enabled, total: stats().total, failed: String(stats().failed) },
        })}
        onClick={() => dialog.show(() => <DialogSelectMcp />)}
        iconClass={stats().failed ? "text-icon-critical-base" : undefined}
      />
    </Show>
  )
}
