import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const sections = [
  {
    requiredTools: ["session_list", "session_read", "session_search", "scope_list"],
    text: "Review recent Home and project activity for unfinished work and decisions needing follow-up.",
  },
  {
    requiredTools: ["note_list", "note_search", "note_read"],
    text: "Identify outdated or scattered knowledge before revising durable documents.",
  },
  {
    requiredTools: ["note_write", "note_search"],
    text: 'Keep one daily journal titled "Daily: YYYY-MM-DD" with the "journal" tag. Record observations, decisions, completed actions, follow-up work, and material limitations. The journal is the routine’s main output; do not send a redundant status message.',
  },
  {
    requiredTools: ["memory_search", "memory_write", "memory_edit", "memory_get"],
    text: "Consolidate durable observations and correct stale memories. Review the supplied inventory for duplicate rules, mixed purposes, incident accumulation and dated status. Preserve scope, exceptions and authorization boundaries; keep session-wide identity and trust rules always available. Separate narrower lessons and historical evidence; temporary status belongs in the journal. Preserve uniquely useful details and verify their retrieval before shortening an entry; if preservation fails, leave the original intact. Re-read before editing and reconsider concurrent changes. Leave clear entries alone; record meaningful changes and limitations in the journal.",
  },
  {
    requiredTools: ["agenda_list", "agenda_logs", "agenda_schedule", "agenda_watch", "agenda_update", "agenda_cancel"],
    text: "Keep follow-up work proportionate, non-duplicative, self-contained, and verifiable. Repair failing or outdated tasks and retire stale ones. Ordinary maintenance stays quiet; notifications require a known supported destination.",
  },
  {
    requiredTools: ["session_send"],
    text: "Notify a known relevant conversation only for a verified urgent finding. Do not send messages merely to demonstrate activity.",
  },
] as const

export function registerAnimaPrompts() {
  AgentPromptContributions.register(
    "anima",
    sections.map((section) => ({
      requiredTools: section.requiredTools,
      render: (_agent, identity) => (identity?.owner === "anima" ? section.text : ""),
    })),
  )
}
