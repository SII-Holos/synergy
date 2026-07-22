import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk"

type Provider = ProviderListResponse["all"][number]
type Model = Provider["models"][string]

export type ModelRef = { providerID: string; modelID: string }

export function isSelectableModel(model: Pick<Model, "status" | "catalogState">) {
  return model.status !== "deprecated" && model.catalogState !== "retained"
}

export function resolveSessionModel(providers: Provider[], ref: ModelRef | undefined) {
  if (!ref) return undefined
  const provider = providers.find((candidate) => candidate.id === ref.providerID)
  const model = provider?.models[ref.modelID]
  if (!provider || !model) return undefined
  return { provider, model }
}
