import { createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function SessionLspIndicator() {
  const sync = useSync()

  const lspStats = createMemo(() => {
    const lsp = sync.data.lsp ?? []
    const connected = lsp.filter((s) => s.status === "connected").length
    const hasError = lsp.some((s) => s.status === "error")
    const total = lsp.length
    return { connected, hasError, total }
  })

  const tooltipContent = createMemo(() => {
    const lsp = sync.data.lsp ?? []
    if (lsp.length === 0) return "No LSP servers"
    return lsp.map((s) => s.name).join(", ")
  })

  return (
    <Show when={lspStats().total > 0}>
      <Tooltip placement="top" value={tooltipContent()}>
        <div class="flex items-center gap-1 px-2 cursor-default select-none">
          <Icon
            name={getSemanticIcon("connection.lsp")}
            size="small"
            class={lspStats().hasError ? "text-icon-critical-base" : undefined}
          />
          <span class="text-12-regular text-text-weak">{lspStats().connected}</span>
        </div>
      </Tooltip>
    </Show>
  )
}
