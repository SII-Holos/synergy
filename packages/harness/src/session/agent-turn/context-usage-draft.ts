import { ContextUsage } from "../context-usage"
import type { AgentTurnInput } from "./worker-pool"

export function startContextUsageDraft(
  input: AgentTurnInput,
  system: string[],
  provenance: ContextUsage.Provenance | undefined,
): Promise<ContextUsage.Draft | undefined> | undefined {
  if (!provenance) return undefined
  return ContextUsage.measureDraft({
    modelID: input.model.id,
    providerID: input.model.providerID,
    limits: input.model.limit,
    instructions: [...system, ...(input.lateSystem ?? [])],
    provenance,
  }).catch(() => undefined)
}
