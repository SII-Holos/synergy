import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { buildPrimaryMemorySection } from "./prompt/primary-memory"
import { buildDeveloperMemory } from "./prompt/developer-memory"
import { buildScribeMemory } from "./prompt/scribe-memory"
import { buildScholarMemory } from "./prompt/scholar-memory"

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["memory_search", "memory_edit", "memory_write"],
    render(agent, identity) {
      if (identity?.owner === "harness" && identity.registrationKey === "developer") return buildDeveloperMemory()
      if (identity?.owner === "harness" && identity.registrationKey === "scribe") return buildScribeMemory()
      if (identity?.owner === "harness" && identity.registrationKey === "scholar") return buildScholarMemory()
      return agent.mode === "primary" || agent.mode === "all" ? buildPrimaryMemorySection() : ""
    },
  },
]

export function registerLibraryPrompts() {
  AgentPromptContributions.register("library", contributions)
}
