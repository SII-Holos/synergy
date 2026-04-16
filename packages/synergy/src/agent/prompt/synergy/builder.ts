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
}

/**
 * Agents that synergy can delegate work to
 */
function getDelegatableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => !a.hidden && a.name !== "synergy" && (a.mode === "subagent" || a.mode === "all"))
}

/**
 * Build the agent table showing available subagents
 */
export function buildAgentTable(agents: AgentInfo[]): string {
  const available = getDelegatableAgents(agents)

  if (available.length === 0) {
    return `No specialized agents available. Use \`master\` for all task execution.`
  }

  const rows = available.map((a) => {
    const desc = a.description?.split(".")[0] || a.description || "General-purpose agent"
    return `| \`${a.name}\` | ${desc} |`
  })

  return `| Agent | Use Case |
|-------|----------|
${rows.join("\n")}

Choose the right agent for the job. Don't use \`master\` when a specialized agent exists for that domain.`
}

function buildSynergyMemorySection(): string {
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
