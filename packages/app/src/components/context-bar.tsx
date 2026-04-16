import { createMemo, createSignal, Show } from "solid-js"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import type { AssistantMessage } from "@ericsanchezok/synergy-sdk/client"
import "./context-bar.css"

export function ContextBar() {
  const sync = useSync()
  const params = useParams()

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const context = createMemo(() => {
    const last = messages().findLast((x) => {
      if (x.role !== "assistant") return false
      const total = x.tokens.input + x.tokens.output + x.tokens.reasoning + x.tokens.cache.read + x.tokens.cache.write
      return total > 0
    }) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.all.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const percentage = createMemo(() => context()?.percentage ?? null)
  const hasContext = createMemo(() => percentage() !== null && percentage()! > 0)

  const level = createMemo(() => {
    const pct = percentage() ?? 0
    if (pct >= 80) return "danger"
    if (pct >= 60) return "warning"
    return "normal"
  })

  return (
    <Show when={hasContext()}>
      <Tooltip
        openDelay={0}
        placement="top"
        value={
          <div class="flex items-center gap-1.5">
            <span class="text-text-invert-strong">{context()?.tokens}</span>
            <span class="text-text-invert-base">tokens</span>
            <span class="text-text-invert-base">·</span>
            <span class="text-text-invert-strong">{percentage()}%</span>
            <span class="text-text-invert-base">used</span>
          </div>
        }
      >
        <div class="context-indicator" data-level={level()}>
          <svg class="context-indicator-ring" viewBox="0 0 20 20">
            <circle class="context-indicator-track" cx="10" cy="10" r="8" />
            <circle
              class="context-indicator-fill"
              cx="10"
              cy="10"
              r="8"
              style={{
                "stroke-dasharray": `${(2 * Math.PI * 8 * Math.min(percentage() ?? 0, 100)) / 100} ${2 * Math.PI * 8}`,
              }}
            />
          </svg>
          <span class="context-indicator-label">{percentage()}</span>
        </div>
      </Tooltip>
    </Show>
  )
}
