/**
 * Synergy Agent Prompt Builder
 *
 * Dynamically builds the synergy agent prompt based on available agents.
 * Synergy is a general-purpose orchestrator that plans, coordinates, executes, and verifies.
 */

import PROMPT_BASE from "./base.txt"
import {
  buildInteractiveMemorySection,
  INTERACTIVE_MEMORY_ALWAYS_CANDIDATES_COMMON,
  INTERACTIVE_MEMORY_BOUNDARY_COMMON,
  INTERACTIVE_MEMORY_METHOD_COMMON,
  INTERACTIVE_MEMORY_PRIORITY_COMMON,
} from "../interactive-memory"

export interface AgentInfo {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
  visibleTo?: string[]
}

/**
 * Agents that synergy can delegate work to
 */
function getDelegatableAgents(agents: AgentInfo[], primaryName = "synergy"): AgentInfo[] {
  return agents.filter(
    (agent) =>
      !agent.hidden &&
      agent.name !== primaryName &&
      (agent.mode === "subagent" || agent.mode === "all") &&
      (!agent.visibleTo || agent.visibleTo.includes(primaryName)),
  )
}

/**
 * Build the agent table showing available subagents
 */
export function buildAgentTable(agents: AgentInfo[], primaryName = "synergy"): string {
  const available = getDelegatableAgents(agents, primaryName)

  if (available.length === 0) {
    return `No specialized subagents are available. Handle only small direct tasks and ask the user to configure subagents for larger work.`
  }

  const rows = available.map((a) => {
    // Show first two sentences so "Use for..." trigger conditions are visible
    const sentences = a.description?.split(".") || []
    const trimmed = sentences.slice(0, 2).filter(Boolean).join(".")
    const desc = trimmed || a.description || "General-purpose agent"
    return `| \`${a.name}\` | ${desc} |`
  })

  return `| Agent | Use Case |
|-------|----------|
${rows.join("\n")}

Choose the narrowest specialized subagent for the current workflow stage. Do not route substantial work to the primary \`${primaryName}\` agent when a subagent can own the stage.`
}

export function buildSynergyMemorySection(): string {
  return buildInteractiveMemorySection({
    intro:
      "During user-facing work, memory is part of execution rather than a background concern. Use it to preserve not just preferences and knowledge, but also durable trust boundaries.",
    boundary: [
      "You are not the user's voice, proxy, or representative by default",
      ...INTERACTIVE_MEMORY_BOUNDARY_COMMON,
      "If the user corrects you for overstepping, treat the correction as a serious trust signal rather than a minor style preference",
      "When approval is required, checkpoint explicitly with the intended recipient, channel, and message content before acting",
    ],
    priority: [
      ...INTERACTIVE_MEMORY_ALWAYS_CANDIDATES_COMMON,
      ...INTERACTIVE_MEMORY_PRIORITY_COMMON,
      "Lessons from incidents where you acted too quickly, exceeded authority, or used the wrong communication surface",
      "Durable rules about when you may act as the user, when you must stay in bot/assistant mode, and when you must ask first",
    ],
    search: [
      "Before assuming prior preferences, collaboration rules, established project conventions, or known trust boundaries",
      'When the user refers to earlier conversations, recurring patterns, or "the way we usually do this"',
      "When prior context could materially change your plan, explanation, implementation choices, or whether an external action is allowed",
      "When a relevant memory may exist but was not auto-injected",
    ],
    edit: [
      "When this session clearly corrects, refines, or supersedes an existing memory",
      "When an existing memory is broadly right but should be consolidated, reworded, or reclassified",
      "When the user sharpens an authorization, privacy, consent, or representation rule that should govern future sessions",
    ],
    write: [
      "When the user establishes a durable rule, preference, or constraint that should shape future sessions",
      "When you learn durable knowledge that future sessions would not quickly recover elsewhere",
      "When the session reveals a durable trust boundary around consent, identity, privacy, or external action",
      "When you explicitly tell the user you will remember something and it has been clearly established in the current interaction",
    ],
    avoid: [
      "Temporary task state, plans, or one-off execution details",
      "Facts that are already easy to recover from code, docs, notes, or session history",
      "Low-confidence guesses or unstable conclusions",
      "A temporary workaround unless the lasting lesson is the boundary or decision rule behind it",
    ],
    method: [
      ...INTERACTIVE_MEMORY_METHOD_COMMON,
      "If you apologize for a boundary mistake and say it will not happen again, persist the rule if tools allow rather than leaving it as a verbal promise",
      "Use `interaction` or `relationship` for consent, representation, tone, language, or trust rules; use `workflow`, `coding`, `writing`, or `knowledge` only when the lesson truly belongs there",
      "For a generalist agent like synergy, err toward `always` when the memory defines how most sessions should begin, be conducted, or be safety-checked",
    ],
  })
}

/**
 * Build the complete synergy prompt
 */
export function buildSynergyPrompt(agents: AgentInfo[]): string {
  const agentTable = buildAgentTable(agents)
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable).replace("{MEMORY_INTERACTION}", buildSynergyMemorySection())
}
