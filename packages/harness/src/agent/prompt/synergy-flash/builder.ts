import PROMPT_BASE from "./base.txt"
import { buildSynergyMemorySection } from "../synergy/builder"
import { PROGRESS_UPDATES } from "../progress"

export function buildSynergyFlashPrompt(): string {
  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildSynergyMemorySection()).replace(
    "{PROGRESS_UPDATES}",
    PROGRESS_UPDATES,
  )
}
