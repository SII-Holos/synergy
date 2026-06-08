import { Show, createMemo } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { AgentGlyph, getAgentVisual } from "@/components/agent-visual"
import type { SessionCortexDelegation } from "@ericsanchezok/synergy-sdk/client"

function formatDuration(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now()
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

function cleanPreview(input?: string): string | undefined {
  if (!input) return undefined

  const noise =
    /^(Execution Trajectory|Steps:?|Tool calls:?|Phases:?|Key Events|Result|Summary|Status:|Task:|Agent:|Description:|Duration:|Health:|Last update:)/i
  const lines = input
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .trim(),
    )
    .filter((line) => {
      if (!line || /^[-*]{3,}$/.test(line)) return false
      if (noise.test(line)) return false
      if (/^Steps:\s*\d+\s*\|\s*Tool calls:/i.test(line)) return false
      return true
    })

  const preview = lines.find((line) => line.length > 16)
  if (!preview) return undefined
  return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview
}

export function SubagentSessionFooter(props: { cortex: SessionCortexDelegation; parentSessionID?: string }) {
  const params = useParams()
  const navigate = useNavigate()

  const visual = createMemo(() => getAgentVisual(props.cortex.agent))
  const preview = createMemo(() => cleanPreview(props.cortex.error ?? props.cortex.result))
  const duration = createMemo(() => formatDuration(props.cortex.startedAt, props.cortex.completedAt))
  const modelLabel = createMemo(() => {
    const m = props.cortex.model
    if (!m) return undefined
    // If provider name is redundant with model prefix, show just modelID
    const provider = m.providerID.replace(/^openai$|^anthropic$|^google$/i, "")
    const model = m.modelID
    return model.startsWith(m.providerID.split("/").pop()!) ? model : `${m.providerID}/${model}`
  })

  const statusInfo = createMemo(() => {
    switch (props.cortex.status) {
      case "queued":
        return { label: "Queued", tone: "text-text-subtle", dot: "bg-text-subtle" }
      case "running":
        return { label: "Running", tone: "text-text-interactive-base", dot: "bg-text-interactive-base" }
      case "completed":
        return { label: "Completed", tone: "text-text-interactive-base", dot: "bg-text-interactive-base" }
      case "error":
        return { label: "Error", tone: "text-red-300", dot: "bg-red-300" }
      case "cancelled":
        return { label: "Cancelled", tone: "text-text-subtle", dot: "bg-text-subtle" }
    }
  })

  return (
    <div
      class="relative rounded-[18px] border border-border-base bg-surface-raised-stronger-non-alpha px-3 py-2.5 shadow-sm"
      style={{
        "border-left": `3px solid color-mix(in srgb, ${visual().color} 72%, var(--border-base))`,
      }}
    >
      <div class="flex items-center gap-3">
        <AgentGlyph agent={props.cortex.agent} size="normal" quiet class="size-8 shrink-0" />

        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-13-medium text-text-base">{visual().label}</span>
            <span class="text-11-regular text-text-subtle">·</span>
            <span class="text-11-regular text-text-subtle">{props.cortex.agent}</span>
            <span class="text-11-regular text-text-subtle">·</span>
            <span class="text-11-regular text-text-subtle">{duration()}</span>
            <Show when={modelLabel()}>
              <span class="text-11-regular text-text-subtle">·</span>
              <span class="truncate text-11-regular text-text-subtle max-w-32">{modelLabel()}</span>
            </Show>
          </div>
          <div class="mt-0.5 truncate text-12-regular text-text-weak">{props.cortex.description}</div>
          <Show when={preview()}>
            <div class="mt-0.5 truncate text-11-regular text-text-subtle">{preview()}</div>
          </Show>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <span class={`hidden sm:inline-flex items-center gap-1.5 text-12-medium ${statusInfo().tone}`}>
            <span class={`size-1.5 rounded-full ${statusInfo().dot}`} />
            {statusInfo().label}
          </span>

          <Show when={props.parentSessionID}>
            <button
              type="button"
              class="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-border-base bg-background-base/55 px-3 text-12-medium text-text-weak transition-all duration-150 hover:bg-surface-raised-stronger-hover hover:text-text-base active:scale-[0.97]"
              onClick={() => navigate(`/${params.dir}/session/${props.parentSessionID}`)}
            >
              <Icon name="arrow-left" size="small" />
              <span class="hidden sm:inline">Parent</span>
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
