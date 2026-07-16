import { Show, createMemo, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { useSync } from "@/context/sync"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { AgentGlyph, getAgentVisual } from "@/components/agent-visual"
import type { SessionCortexDelegation, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { subagentFooterSessionStatus } from "./subagent-session-footer-model"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { S } from "./session-i18n"

const HIDE_MODEL_LABEL_AGENTS = new Set(["codex", "claude-code"])

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

function outputPreview(output?: SessionCortexDelegation["output"]): string | undefined {
  if (!output) return undefined
  if (output.mode === "structured") return JSON.stringify(output.value, null, 2)
  return output.value
}

export function SubagentSessionFooter(props: {
  cortex: SessionCortexDelegation
  sessionID: string
  parentSessionID?: string
}) {
  const sync = useSync()
  const navigateToSession = useNavigateToSession()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)

  const visual = createMemo(() => getAgentVisual(props.cortex.agent))
  const preview = createMemo(() => cleanPreview(props.cortex.error ?? outputPreview(props.cortex.output)))
  const [tick, setTick] = createSignal(0)
  const sessionStatus = createMemo<SessionStatus | undefined>(() =>
    subagentFooterSessionStatus(sync.data.session_status, props.sessionID),
  )
  createEffect(() => {
    if (props.cortex.status !== "running") return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    onCleanup(() => clearInterval(id))
  })

  const duration = createMemo(() => {
    tick()
    return formatDuration(props.cortex.startedAt, props.cortex.completedAt)
  })
  const modelLabel = createMemo(() => {
    if (HIDE_MODEL_LABEL_AGENTS.has(props.cortex.agent)) return undefined
    const m = props.cortex.model
    if (!m) return undefined
    const model = m.modelID
    return model.startsWith(m.providerID.split("/").pop()!) ? model : `${m.providerID}/${model}`
  })

  const retryStatus = createMemo(() => {
    const s = sessionStatus()
    if (s?.type === "retry") return s
    return undefined
  })

  const statusInfo = createMemo(() => {
    const rs = retryStatus()
    if (rs) {
      return {
        label: i18n._({ ...S.subagentFooterRetry, values: { attempt: rs.attempt } }),
        tone: "text-text-on-critical-base",
        dot: "bg-icon-critical-base",
      }
    }
    switch (props.cortex.status) {
      case "queued":
        return { label: _(S.subagentFooterQueued), tone: "text-text-subtle", dot: "bg-text-subtle" }
      case "running":
        return {
          label: _(S.subagentFooterRunning),
          tone: "text-text-interactive-base",
          dot: "bg-text-interactive-base",
        }
      case "completed":
        return { label: _(S.subagentFooterCompleted), tone: "text-text-on-success-base", dot: "bg-border-success-base" }
      case "error":
        return { label: _(S.subagentFooterError), tone: "text-text-on-critical-base", dot: "bg-icon-critical-base" }
      case "cancelled":
        return { label: _(S.subagentFooterCancelled), tone: "text-text-subtle", dot: "bg-text-subtle" }
      case "interrupted":
        return { label: _(S.subagentFooterInterrupted), tone: "text-text-on-warning-base", dot: "bg-icon-warning-base" }
    }
  })

  return (
    <div class="workbench-card-surface relative rounded-[18px] border border-border-base px-3 py-2.5">
      <div class="flex items-center gap-3">
        <AgentGlyph agent={props.cortex.agent} size="normal" quiet class="size-8 shrink-0" />

        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-13-medium text-text-base">{translateDescriptor(visual().label, i18n)}</span>
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
            {(parentSessionID) => (
              <button
                type="button"
                class="workbench-control-surface workbench-control-surface-hover inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-border-base px-3 text-12-medium text-text-weak transition-all duration-150 hover:text-text-base active:scale-[0.97]"
                onClick={() => navigateToSession(untrack(parentSessionID))}
              >
                <Icon name={getSemanticIcon("navigation.back")} size="small" />
                <span class="hidden sm:inline">{_(S.subagentFooterParent)}</span>
              </button>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
