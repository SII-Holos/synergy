import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import type { JSX } from "solid-js"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export interface AgentVisual {
  icon: IconName
  label: string
  color: string
  external?: boolean
}

const VISUALS: Record<string, AgentVisual> = {
  synergy: { icon: "sparkles", label: "Synergy", color: "rgba(99, 102, 241, 0.35)" },
  master: { icon: "code", label: "Master", color: "rgba(59, 130, 246, 0.35)" },
  explore: { icon: "search", label: "Explore", color: "rgba(168, 85, 247, 0.35)" },
  scribe: { icon: "pen-line", label: "Scribe", color: "rgba(34, 197, 94, 0.35)" },
  scholar: { icon: "brain", label: "Scholar", color: "rgba(245, 158, 11, 0.35)" },
  scout: { icon: "compass", label: "Scout", color: "rgba(6, 182, 212, 0.35)" },
  advisor: { icon: "glasses", label: "Advisor", color: "rgba(236, 72, 153, 0.35)" },
  codex: { icon: "sparkles", label: "Codex", color: "rgba(14, 165, 233, 0.35)", external: true },
  "claude-code": { icon: "bot", label: "Claude Code", color: "rgba(249, 115, 22, 0.35)", external: true },
  openclaw: { icon: "workflow", label: "OpenClaw", color: "rgba(16, 185, 129, 0.35)", external: true },
}

const DEFAULT_VISUAL: AgentVisual = {
  icon: "bot",
  label: "Agent",
  color: "rgba(107, 114, 128, 0.35)",
}

export function getAgentVisual(input?: string | Pick<Agent, "name" | "external"> | null): AgentVisual {
  if (!input) return DEFAULT_VISUAL
  if (typeof input === "string") return VISUALS[input] ?? { ...DEFAULT_VISUAL, label: titlecaseAgentName(input) }

  const byName = VISUALS[input.name]
  if (byName) return byName
  if (input.external?.adapter && VISUALS[input.external.adapter]) {
    return VISUALS[input.external.adapter]
  }

  return {
    ...DEFAULT_VISUAL,
    label: titlecaseAgentName(input.name),
    external: !!input.external,
  }
}

export function titlecaseAgentName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function AgentGlyph(props: {
  agent?: string | Pick<Agent, "name" | "external"> | null
  class?: string
  size?: "small" | "normal" | "large"
  style?: JSX.CSSProperties
}) {
  const visual = getAgentVisual(props.agent)
  return (
    <span
      class={`inline-flex items-center justify-center rounded-full border border-border-base bg-surface-raised-stronger-non-alpha ${props.class ?? ""}`}
      style={{
        color: "var(--icon-base)",
        "box-shadow": `0 0 0 2px color-mix(in srgb, ${visual.color} 45%, transparent)`,
        ...props.style,
      }}
    >
      <Icon name={visual.icon} size={props.size ?? "small"} class="text-icon-base" />
    </span>
  )
}

export function AgentPill(props: {
  agent?: string | Pick<Agent, "name" | "external"> | null
  showLabel?: boolean
  showExternalBadge?: boolean
  class?: string
}) {
  const visual = getAgentVisual(props.agent)
  return (
    <span
      class={`inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-2 py-0.5 text-11-medium text-text-weak ${props.class ?? ""}`}
      style={{
        "box-shadow": `0 0 0 2px color-mix(in srgb, ${visual.color} 35%, transparent)`,
      }}
    >
      <Icon name={visual.icon} size="small" class="text-icon-base" />
      {props.showLabel !== false && <span>{visual.label}</span>}
      {props.showExternalBadge && visual.external && (
        <span class="rounded-full bg-surface-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
          External
        </span>
      )}
    </span>
  )
}
