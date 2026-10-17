import { PROGRESS_UPDATES } from "../progress"
import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { TRUST_BOUNDARIES } from "../trust-boundaries"

export function buildCodingPrompt(): string {
  return PrimaryAgentIdentity.render(
    "coding",
    PROMPT_BASE.replace("{MEMORY_INTERACTION}", TRUST_BOUNDARIES).replace("{PROGRESS_UPDATES}", PROGRESS_UPDATES),
  )
}
