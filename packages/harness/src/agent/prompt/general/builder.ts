import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { TRUST_BOUNDARIES } from "../trust-boundaries"

export function buildGeneralPrompt(): string {
  return PrimaryAgentIdentity.render("general", PROMPT_BASE.replace("{MEMORY_INTERACTION}", TRUST_BOUNDARIES))
}
