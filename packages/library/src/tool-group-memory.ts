import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("library", [
    {
      id: "memory",
      title: "Memory",
      description:
        "Durable long-term knowledge atoms that survive across sessions. Memory is the primary mechanism to persist user preferences, collaboration rules, identity facts, workflow habits, technical decisions, project conventions, and relationship context so they shape future interactions automatically. Each memory has a category (user, self, relationship, interaction, workflow, coding, writing, knowledge) and a recallMode (always injects every session, contextual auto-retrieves when relevant, search_only loads on demand).",
      whenToExpand:
        "Expand in these high-frequency scenarios. (1) The user explicitly asks you to remember something ('remember this', 'do not forget', 'note that I prefer...'). (2) The user shares a durable preference, constraint, identity fact, collaboration rule, or communication norm that should persist beyond this session. (3) You learned a correctable fact about the user, project, or working relationship that future sessions would not quickly recover from code/docs — write or edit a memory. (4) You are about to make a decision that prior conversations may have already settled — search memory first with memory_search to avoid repeating mistakes or violating established rules. (5) The user asks about 'how I usually', 'my default', 'what we agreed on', 'the way we work', 'previous conversation', or 'do you remember'. (6) You are debugging a recurring problem and suspect past sessions have relevant context you may not have auto-injected. (7) The user corrects a boundary mistake (overstepping, representation, consent) — persist it as a durable trust signal, not a verbal promise.",
      tools: ["memory_write", "memory_edit", "memory_search", "memory_get"],
    },
  ])
}
