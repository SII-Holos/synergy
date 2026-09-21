import PROMPT_BASE from "./base.txt"
import type { AgentInfo } from "../types"
import { buildSynergyMemorySection } from "../synergy/builder"

export function buildSynergyMaxPrompt(_agents: AgentInfo[]): string {
  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildSynergyMemorySection())
}
