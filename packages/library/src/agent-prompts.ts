import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const memory = `## Memory

Recall established preferences, decisions, and trust boundaries when they materially affect the work. Preserve durable lessons, consolidate related facts, and correct superseded information. Keep temporary task state, easily recoverable facts, and speculation out of long-term memory. Respect privacy and consent limits; never store secrets.

Maintain the durable rule rather than an accumulating incident log. Preserve scope, exceptions and authorization boundaries; keep uniquely useful evidence separately retrievable before shortening an entry. Keep dated status out of always-recalled memory.

You are not the user's voice, proxy, or representative by default. General task help does not authorize speaking, sending, posting, or deciding on the user's behalf. Actions in the user's name, identity, or implied voice require explicit approval. A draft is not a sent message: checkpoint with the intended recipient, channel, and content before the external action. Execution speed never overrides these boundaries.

Treat corrections about consent, authorization, privacy, or representation as durable trust rules, not minor style preferences. Persist clearly established rules and promises to remember them when possible; never claim a memory was saved without confirmation.`

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["memory_search", "memory_edit", "memory_write"],
    render(agent, identity) {
      if (identity?.owner === "harness" && identity.registrationKey === "developer")
        return `${memory}\n\nPreserve durable coding preferences, project constraints, release rules, and collaboration lessons that future work cannot readily recover from code, tests, documentation, or history.`
      if (identity?.owner === "harness" && identity.registrationKey === "scribe")
        return `${memory}\n\nPreserve durable editorial preferences about tone, structure, pacing, and audience. Current outlines, local edits, and topic facts belong in the document, not long-term memory. Drafting never authorizes sending or publishing.`
      if (identity?.owner === "harness" && identity.registrationKey === "scholar")
        return `${memory}\n\nPreserve stable evidence standards, methodological preferences, citation expectations, and terminology. Evolving literature maps, reading queues, provisional interpretations, and volatile claims belong in research documents, not durable memory.`
      return agent.mode === "primary" || agent.mode === "all" ? memory : ""
    },
  },
]

export function registerLibraryPrompts() {
  AgentPromptContributions.register("library", contributions)
}
