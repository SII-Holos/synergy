import { createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLocale } from "@/context/locale"
import { StatusBarIndicator } from "@/components/status-bar"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { computeLspStats } from "./session-connection-stats"
import { S } from "./session-i18n"

export function SessionLspIndicator() {
  const sync = useSync()
  const { i18n } = useLocale()

  const stats = createMemo(() => computeLspStats(sync.data.lsp))

  const tooltipContent = createMemo(() => {
    const lsp = sync.data.lsp ?? []
    if (lsp.length === 0) return i18n._(S.lspNoServers)
    return lsp.map((s) => s.name).join(", ")
  })

  return (
    <Show when={stats().total > 0}>
      <StatusBarIndicator
        icon={getSemanticIcon("lsp.main")}
        value={stats().connected}
        tooltip={tooltipContent()}
        iconClass={stats().hasError ? "text-icon-critical-base" : undefined}
      />
    </Show>
  )
}
