import type { JSX } from "solid-js"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export interface AgentVisual {
  emoji: string
  label: string
  color: string
  external?: boolean
}

const COLORS = {
  primary: "rgba(99, 102, 241, 0.35)",
  max: "rgba(249, 115, 22, 0.35)",
  code: "rgba(59, 130, 246, 0.35)",
  analysis: "rgba(168, 85, 247, 0.35)",
  design: "rgba(245, 158, 11, 0.35)",
  test: "rgba(34, 197, 94, 0.35)",
  quality: "rgba(20, 184, 166, 0.35)",
  review: "rgba(236, 72, 153, 0.35)",
  knowledge: "rgba(14, 165, 233, 0.35)",
  research: "rgba(139, 92, 246, 0.35)",
  external: "rgba(16, 185, 129, 0.35)",
  neutral: "rgba(107, 114, 128, 0.35)",
} as const

const VISUALS: Record<string, AgentVisual> = {
  synergy: { emoji: "😌", label: "Synergy", color: COLORS.primary },
  "synergy-max": { emoji: "🧑‍💼", label: "Synergy Max", color: COLORS.max },

  developer: { emoji: "😎", label: "Developer", color: COLORS.code },
  explore: { emoji: "🥸", label: "Explore", color: COLORS.analysis },
  scout: { emoji: "🤩", label: "Scout", color: COLORS.knowledge },
  advisor: { emoji: "🧐", label: "Advisor", color: COLORS.design },
  inspector: { emoji: "😤", label: "Inspector", color: COLORS.review },
  scribe: { emoji: "🤭", label: "Scribe", color: COLORS.test },
  scholar: { emoji: "🤓", label: "Scholar", color: COLORS.research },

  "intent-analyst": { emoji: "🤔", label: "Intent Analyst", color: COLORS.analysis },
  "requirements-engineer": { emoji: "🧐", label: "Requirements", color: COLORS.analysis },
  "code-cartographer": { emoji: "😶‍🌫️", label: "Code Map", color: COLORS.analysis },
  "dependency-tracer": { emoji: "🙄", label: "Dependency Trace", color: COLORS.analysis },

  "solution-architect": { emoji: "😏", label: "Solution Architect", color: COLORS.design },
  "api-contract-designer": { emoji: "😌", label: "API Contract", color: COLORS.design },
  "migration-architect": { emoji: "😰", label: "Migration", color: COLORS.design },

  "test-strategist": { emoji: "😈", label: "Test Strategy", color: COLORS.test },
  "regression-reproducer": { emoji: "😫", label: "Regression", color: COLORS.test },
  "fixture-builder": { emoji: "😼", label: "Fixtures", color: COLORS.test },
  "property-test-engineer": { emoji: "🤖", label: "Property Tests", color: COLORS.test },
  "type-test-engineer": { emoji: "😑", label: "Type Tests", color: COLORS.test },

  "implementation-engineer": { emoji: "😤", label: "Implementation", color: COLORS.code },
  "refactoring-engineer": { emoji: "😇", label: "Refactor", color: COLORS.code },
  "integration-engineer": { emoji: "🤝", label: "Integration", color: COLORS.code },
  "documentation-engineer": { emoji: "🙂", label: "Docs", color: COLORS.code },

  "quality-gatekeeper": { emoji: "😐", label: "Quality Gate", color: COLORS.quality },
  "python-quality-engineer": { emoji: "😜", label: "Python Quality", color: COLORS.quality },
  "rust-quality-engineer": { emoji: "😤", label: "Rust Quality", color: COLORS.quality },
  "typescript-quality-engineer": { emoji: "😬", label: "TS Quality", color: COLORS.quality },

  "maintainability-reviewer": { emoji: "😒", label: "Maintainability", color: COLORS.review },
  "security-reviewer": { emoji: "😠", label: "Security", color: COLORS.review },
  "performance-reviewer": { emoji: "😳", label: "Performance", color: COLORS.review },
  "api-compatibility-reviewer": { emoji: "😕", label: "API Compatibility", color: COLORS.review },
  "documentation-reviewer": { emoji: "🙂‍↔️", label: "Doc Review", color: COLORS.review },

  "docs-researcher": { emoji: "🤩", label: "Docs Research", color: COLORS.knowledge },
  "research-methodologist": { emoji: "🤔", label: "Research Method", color: COLORS.research },
  "memory-curator": { emoji: "🤗", label: "Memory", color: COLORS.knowledge },
  "note-librarian": { emoji: "😊", label: "Notes", color: COLORS.knowledge },
  "session-historian": { emoji: "🤨", label: "Session History", color: COLORS.knowledge },

  codex: { emoji: "🫡", label: "Codex", color: COLORS.knowledge, external: true },
  "claude-code": { emoji: "🤨", label: "Claude Code", color: COLORS.max, external: true },
  openclaw: { emoji: "🤯", label: "OpenClaw", color: COLORS.external, external: true },
}

const DEFAULT_VISUAL: AgentVisual = {
  emoji: "🤷",
  label: "Agent",
  color: COLORS.neutral,
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
