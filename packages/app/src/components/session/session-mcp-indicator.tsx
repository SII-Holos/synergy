import { createMemo, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSync } from "@/context/sync"
import { DialogSelectMcp } from "@/components/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function SessionMcpIndicator() {
  const sync = useSync()
  const dialog = useDialog()

  const mcpStats = createMemo(() => {
    const mcp = sync.data.mcp ?? {}
    const entries = Object.entries(mcp)
    const enabled = entries.filter(([, status]) => status.status === "connected").length
    const failed = entries.some(([, status]) => status.status === "failed")
    const total = entries.length
    return { enabled, failed, total }
  })

  return (
    <Show when={mcpStats().total > 0}>
      <Button variant="ghost" onClick={() => dialog.show(() => <DialogSelectMcp />)}>
        <Icon
          name={getSemanticIcon("connection.mcp")}
          size="small"
          class={mcpStats().failed ? "text-icon-critical-base" : undefined}
        />
        <span class="text-12-regular text-text-weak">{mcpStats().enabled}</span>
      </Button>
    </Show>
  )
}
