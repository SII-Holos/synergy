import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { buildPrimaryMemorySection } from "../primary-memory"

export function buildCodingPrompt(): string {
  return PrimaryAgentIdentity.render("coding", PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildPrimaryMemorySection()))
}
