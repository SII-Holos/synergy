import PROMPT_BASE from "./base.txt"
import { buildSynergyMemorySection } from "../synergy/builder"

export function buildSynergyFlashPrompt(): string {
  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildSynergyMemorySection())
}
