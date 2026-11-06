import PROMPT_BASE from "./base.txt"
import { TRUST_BOUNDARIES } from "../trust-boundaries"

export function buildDeveloperPrompt(): string {
  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", TRUST_BOUNDARIES)
}
