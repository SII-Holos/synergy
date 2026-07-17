import type { AppMessageDescriptor } from "@/locales/messages"
import { agentVisual as agentVisualMsgs } from "@/locales/messages"
import { useLingui } from "@lingui/solid"
import { useLocale } from "@/context/locale"
import type { JSX } from "solid-js"
import { AP } from "@/app-i18n"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export interface AgentVisual {
  emoji: string
  label: AppMessageDescriptor
  color: string
  external?: boolean
}

const COLORS = {
  primary: "var(--text-interactive-base)",
  max: "var(--avatar-text-orange)",
  code: "var(--avatar-text-cyan)",
  analysis: "var(--avatar-text-purple)",
  design: "var(--text-on-warning-base)",
  test: "var(--text-on-success-base)",
  quality: "var(--avatar-text-mint)",
  review: "var(--avatar-text-pink)",
  knowledge: "var(--text-on-info-base)",
  research: "var(--avatar-text-purple)",
  external: "var(--avatar-text-mint)",
  supervisor: "var(--text-on-critical-base)",
  neutral: "var(--text-weak)",
} as const

const VISUALS: Record<string, AgentVisual> = {
  synergy: { emoji: "😌", label: agentVisualMsgs.roleSynergy, color: COLORS.primary },
  "synergy-max": { emoji: "🧑‍💼", label: agentVisualMsgs.roleSynergyMax, color: COLORS.max },

  developer: { emoji: "😎", label: agentVisualMsgs.roleDeveloper, color: COLORS.code },
  explore: { emoji: "🥸", label: agentVisualMsgs.roleExplore, color: COLORS.analysis },
  scout: { emoji: "🤩", label: agentVisualMsgs.roleScout, color: COLORS.knowledge },
  advisor: { emoji: "🧐", label: agentVisualMsgs.roleAdvisor, color: COLORS.design },
  inspector: { emoji: "😤", label: agentVisualMsgs.roleInspector, color: COLORS.review },
  scribe: { emoji: "🤭", label: agentVisualMsgs.roleScribe, color: COLORS.test },
  scholar: { emoji: "🤓", label: agentVisualMsgs.roleScholar, color: COLORS.research },

  "requirements-engineer": { emoji: "😥", label: agentVisualMsgs.roleRequirements, color: COLORS.analysis },
  "code-cartographer": { emoji: "😶‍🌫️", label: agentVisualMsgs.roleCodeMap, color: COLORS.analysis },
  "dependency-tracer": { emoji: "🙄", label: agentVisualMsgs.roleDependencyTrace, color: COLORS.analysis },

  "solution-architect": { emoji: "😏", label: agentVisualMsgs.roleSolutionArchitect, color: COLORS.design },
  "api-contract-designer": { emoji: "🤫", label: agentVisualMsgs.roleApiContract, color: COLORS.design },
  "migration-architect": { emoji: "😰", label: agentVisualMsgs.roleMigration, color: COLORS.design },

  "test-strategist": { emoji: "😈", label: agentVisualMsgs.roleTestStrategy, color: COLORS.test },
  "fixture-builder": { emoji: "😼", label: agentVisualMsgs.roleFixtures, color: COLORS.test },
  "property-test-engineer": { emoji: "🤖", label: agentVisualMsgs.rolePropertyTests, color: COLORS.test },
  "type-test-engineer": { emoji: "😑", label: agentVisualMsgs.roleTypeTests, color: COLORS.test },

  "implementation-engineer": { emoji: "😡", label: agentVisualMsgs.roleImplementation, color: COLORS.code },
  "refactoring-engineer": { emoji: "😇", label: agentVisualMsgs.roleRefactor, color: COLORS.code },
  "integration-engineer": { emoji: "🤝", label: agentVisualMsgs.roleIntegration, color: COLORS.code },
  "documentation-engineer": { emoji: "🙂", label: agentVisualMsgs.roleDocs, color: COLORS.code },

  "quality-gatekeeper": { emoji: "😐", label: agentVisualMsgs.roleQualityGate, color: COLORS.quality },
  "python-quality-engineer": { emoji: "😜", label: agentVisualMsgs.rolePythonQuality, color: COLORS.quality },
  "rust-quality-engineer": { emoji: "😓", label: agentVisualMsgs.roleRustQuality, color: COLORS.quality },
  "typescript-quality-engineer": { emoji: "😬", label: agentVisualMsgs.roleTsQuality, color: COLORS.quality },

  "maintainability-reviewer": { emoji: "😒", label: agentVisualMsgs.roleMaintainability, color: COLORS.review },
  "security-reviewer": { emoji: "😠", label: agentVisualMsgs.roleSecurity, color: COLORS.review },
  "performance-reviewer": { emoji: "😳", label: agentVisualMsgs.rolePerformance, color: COLORS.review },
  "api-compatibility-reviewer": { emoji: "😕", label: agentVisualMsgs.roleApiCompatibility, color: COLORS.review },
  "documentation-reviewer": { emoji: "🙂‍↔️", label: agentVisualMsgs.roleDocReview, color: COLORS.review },

  "docs-researcher": { emoji: "🫨", label: agentVisualMsgs.roleDocsResearch, color: COLORS.knowledge },
  "research-methodologist": { emoji: "😖", label: agentVisualMsgs.roleResearchMethod, color: COLORS.research },
  "research-scout": { emoji: "🫣", label: agentVisualMsgs.roleResearchScout, color: COLORS.research },
  "literature-searcher": { emoji: "🫢", label: agentVisualMsgs.roleLiteratureSearch, color: COLORS.research },
  "literature-analyst": { emoji: "😯", label: agentVisualMsgs.roleLiteratureAnalyst, color: COLORS.research },
  "memory-curator": { emoji: "🤗", label: agentVisualMsgs.roleMemory, color: COLORS.knowledge },
  "note-librarian": { emoji: "😊", label: agentVisualMsgs.roleNotes, color: COLORS.knowledge },
  "session-historian": { emoji: "🤨", label: agentVisualMsgs.roleSessionHistory, color: COLORS.knowledge },

  supervisor: { emoji: "👀", label: agentVisualMsgs.roleSupervisor, color: COLORS.supervisor },

  codex: { emoji: "🫡", label: agentVisualMsgs.roleCodex, color: COLORS.knowledge, external: true },
  "claude-code": { emoji: "😉", label: agentVisualMsgs.roleClaudeCode, color: COLORS.max, external: true },
  openclaw: { emoji: "🤯", label: agentVisualMsgs.roleOpenClaw, color: COLORS.external, external: true },
}

const DEFAULT_VISUAL: AgentVisual = {
  emoji: "\uD83E\uDD37",
  label: agentVisualMsgs.defaultLabel,
  color: COLORS.neutral,
}

export function getAgentVisual(input?: string | Pick<Agent, "name" | "external"> | null): AgentVisual {
  if (!input) return DEFAULT_VISUAL
  if (typeof input === "string") return VISUALS[input] ?? { ...DEFAULT_VISUAL, label: dynamicLabel(input) }

  const byName = VISUALS[input.name]
  if (byName) return byName
  if (input.external?.adapter && VISUALS[input.external.adapter]) {
    return VISUALS[input.external.adapter]
  }

  return {
    ...DEFAULT_VISUAL,
    label: dynamicLabel(input.name),
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

function dynamicLabel(name: string): AppMessageDescriptor {
  return {
    id: `app.agent.role.dynamic.${name.toLowerCase().replace(/[-_\s]+/g, "-")}`,
    message: titlecaseAgentName(name),
  }
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
  const { i18n } = useLocale()
  const lingui = useLingui()
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
      {props.showLabel !== false && <span>{lingui._(visual.label)}</span>}
      {props.showExternalBadge && visual.external && (
        <span class="rounded-full bg-surface-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
          {i18n._(AP.agentVisualExternal.id)}
        </span>
      )}
    </span>
  )
}
