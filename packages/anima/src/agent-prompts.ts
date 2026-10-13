import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const sections = [
  {
    requiredTools: ["session_list", "session_read", "session_search", "scope_list"],
    text: "Sensing: use session_list with since to find recent Home and project activity, session_read for important context, and session_search for specific topics. Use scope_list to find a project's scope before narrowing the search. Identify unfinished work and decisions that need follow-up.",
  },
  {
    requiredTools: ["note_list", "note_search", "note_read"],
    text: "Review recent knowledge with note_list, note_search and note_read. Identify outdated or scattered information before changing a document.",
  },
  {
    requiredTools: ["note_write", "note_search"],
    text: 'Daily journal: each routine writes a note titled "Daily: YYYY-MM-DD" with tags ["journal"]. Use note_search to locate today’s journal and note_write in append mode when it already exists. Record observations, decisions, completed actions, follow-up work, and material limitations. The journal is the routine’s main output; do not send a redundant status message.',
  },
  {
    requiredTools: ["memory_search", "memory_write", "memory_edit"],
    text: "Memory health: use memory_search before recording a fact. Use memory_write for new knowledge and memory_edit to consolidate existing entries. Keep always-recalled user, self, relationship and interaction memories concise. Use contextual recall for relevant working knowledge and search_only for background details; do not downgrade durable instructions merely to save space.",
  },
  {
    requiredTools: ["agenda_list", "agenda_logs", "agenda_schedule", "agenda_watch", "agenda_update", "agenda_cancel"],
    text: "Agenda orchestration: review agenda_list and agenda_logs before scheduling. Use agenda_schedule for recurring work and agenda_watch for a one-time follow-up. Give every task a self-contained prompt, relevant sessionRefs, and success criteria. Use agenda_update to repair failing or outdated tasks and agenda_cancel for stale ones. Avoid duplicates and over-scheduling; five focused tasks is normally enough. Spread useful follow-up across the day. Use silent delivery when no user notification is needed; otherwise use a known supported target, without assuming a channel exists.",
  },
  {
    requiredTools: ["session_send"],
    text: "For a verified urgent finding, session_send can notify a known relevant session. Ordinary routine completion should remain quiet; do not send messages merely to demonstrate activity.",
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
