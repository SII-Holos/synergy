import { PROGRESS_UPDATES } from "../progress"
import PROMPT_BASE from "./base.txt"
import { PrimaryAgentIdentity } from "../../primary-identity"
import { buildPrimaryMemorySection } from "../primary-memory"

export function buildLightweightPrompt(): string {
  return PrimaryAgentIdentity.render(
    "lightweight",
    PROMPT_BASE.replace("{MEMORY_INTERACTION}", buildPrimaryMemorySection()).replace(
      "{PROGRESS_UPDATES}",
      PROGRESS_UPDATES,
    ),
  )
}
