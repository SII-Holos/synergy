import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { buildPrimaryMemorySection } from "../primary-memory"

export function buildGeneralPrompt(): string {
  return PrimaryAgentIdentity.render(
    "general",
    PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildPrimaryMemorySection()),
  )
}
