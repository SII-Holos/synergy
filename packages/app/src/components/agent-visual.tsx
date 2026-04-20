import type { JSX } from "solid-js"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export interface AgentVisual {
  emoji: string
  label: string
  color: string
  external?: boolean
}

const VISUALS: Record<string, AgentVisual> = {
  synergy: { emoji: "😌", label: "Synergy", color: "rgba(99, 102, 241, 0.35)" },
  master: { emoji: "😎", label: "Master", color: "rgba(59, 130, 246, 0.35)" },
  explore: { emoji: "🤨", label: "Explore", color: "rgba(168, 85, 247, 0.35)" },
  scribe: { emoji: "😏", label: "Scribe", color: "rgba(34, 197, 94, 0.35)" },
  scholar: { emoji: "🤓", label: "Scholar", color: "rgba(245, 158, 11, 0.35)" },
  scout: { emoji: "🤩", label: "Scout", color: "rgba(6, 182, 212, 0.35)" },
  advisor: { emoji: "🧐", label: "Advisor", color: "rgba(236, 72, 153, 0.35)" },
  codex: { emoji: "🫡", label: "Codex", color: "rgba(14, 165, 233, 0.35)", external: true },
  "claude-code": { emoji: "🥸", label: "Claude Code", color: "rgba(249, 115, 22, 0.35)", external: true },
  openclaw: { emoji: "🤯", label: "OpenClaw", color: "rgba(16, 185, 129, 0.35)", external: true },
}

const DEFAULT_VISUAL: AgentVisual = {
  emoji: "🤷",
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

const EMOJI_SIZE_MAP: Record<string, string> = {
  small: "14px",
  normal: "18px",
  large: "24px",
}

export function AgentGlyph(props: {
  agent?: string | Pick<Agent, "name" | "external"> | null
  class?: string
  size?: "small" | "normal" | "large"
  style?: JSX.CSSProperties
  quiet?: boolean
}) {
  const visual = getAgentVisual(props.agent)
  return (
    <span
      class={`inline-flex items-center justify-center rounded-full border border-border-base bg-surface-raised-stronger-non-alpha ${props.class ?? ""}`}
      style={{
        ...(props.quiet ? {} : { "box-shadow": `0 0 0 2px color-mix(in srgb, ${visual.color} 45%, transparent)` }),
        ...props.style,
      }}
    >
      <span class="select-none leading-none" style={{ "font-size": EMOJI_SIZE_MAP[props.size ?? "small"] }}>
        {visual.emoji}
      </span>
    </span>
  )
}

export function AgentPill(props: {
  agent?: string | Pick<Agent, "name" | "external"> | null
  showLabel?: boolean
  showExternalBadge?: boolean
  class?: string
  quiet?: boolean
}) {
  const visual = getAgentVisual(props.agent)
  return (
    <span
      class={`inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-2 py-0.5 text-11-medium text-text-weak ${props.class ?? ""}`}
      style={
        props.quiet
          ? undefined
          : {
              "box-shadow": `0 0 0 2px color-mix(in srgb, ${visual.color} 35%, transparent)`,
            }
      }
    >
      <span class="select-none leading-none" style={{ "font-size": "14px" }}>
        {visual.emoji}
      </span>
      {props.showLabel !== false && <span>{visual.label}</span>}
      {props.showExternalBadge && visual.external && (
        <span class="rounded-full bg-surface-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
          External
        </span>
      )}
    </span>
  )
}
