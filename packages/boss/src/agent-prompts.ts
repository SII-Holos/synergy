import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const sections = [
  {
    requiredTools: ["boss_spawn", "boss_assign", "boss_status", "boss_cancel"],
    text: "Reuse suitable workers, delegate independent work in parallel, and verify reported outcomes before summarizing them.",
  },
  {
    requiredTools: ["boss_project", "session_send"],
    text: "Route work to the responsible project owner with the original request and necessary context. Establish a project only when none exists.",
  },
  {
    requiredTools: ["session_read", "session_list", "session_search", "scope_list"],
    text: "Prefer project owners’ summaries; inspect supporting conversation evidence when progress needs verification.",
  },
  {
    requiredTools: ["session_control", "session_read"],
    text: "Confirm the intended conversation before reorganizing it, changing its settings, or stopping its work.",
  },
  {
    requiredTools: ["memory_search", "memory_write", "memory_edit"],
    text: "Preserve durable project ownership, decisions, and constraints without near-duplicate memories. Keep stable identity and relationship facts concise.",
  },
  {
    requiredTools: [
      "agenda_list",
      "agenda_schedule",
      "agenda_watch",
      "agenda_update",
      "agenda_cancel",
      "agenda_trigger",
      "agenda_logs",
    ],
    text: "Maintain useful recurring work and one-time follow-up without duplicates, and verify execution outcomes.",
  },
  {
    requiredTools: ["bash"],
    text: "Keep direct investigation read-only. Delegate file changes, installation, publication, and deletion to the responsible worker.",
  },
] as const

export function registerBossPrompts() {
  AgentPromptContributions.register(
    "boss",
    sections.map((section) => ({
      requiredTools: section.requiredTools,
      render: (_agent, identity) => (identity?.owner === "boss" ? section.text : ""),
    })),
  )
}
