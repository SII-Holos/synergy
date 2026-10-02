import PROMPT_BASE from "./base.txt"
import type { AgentInfo } from "../types"
import { buildSynergyMemorySection } from "../synergy/builder"
import { PROGRESS_UPDATES } from "../progress"

export function buildSynergyMaxPrompt(_agents: AgentInfo[]): string {
  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildSynergyMemorySection()).replace(
    "{PROGRESS_UPDATES}",
    PROGRESS_UPDATES,
  )
}
