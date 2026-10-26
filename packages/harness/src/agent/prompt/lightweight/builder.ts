import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { TRUST_BOUNDARIES } from "../trust-boundaries"

export function buildLightweightPrompt(): string {
  return PrimaryAgentIdentity.render("lightweight", PROMPT_BASE.replace("{MEMORY_INTERACTION}", TRUST_BOUNDARIES))
}
