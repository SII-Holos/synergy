import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk"

type Provider = ProviderListResponse["all"][number]
type Model = Provider["models"][string]

export type ModelRef = { providerID: string; modelID: string }

export function isSelectableModel(model: Pick<Model, "status" | "catalogState">) {
  return model.status !== "deprecated" && model.catalogState !== "retained"
}

export function listSelectableConnectedModels(
  providers: readonly Provider[],
  connectedProviderIDs: readonly string[],
  providerID?: string,
) {
  const connected = new Set(connectedProviderIDs)

  return providers.flatMap((provider) => {
    if (!connected.has(provider.id) || (providerID && provider.id !== providerID)) return []

    return Object.values(provider.models)
      .filter(isSelectableModel)
      .map((model) => ({
        ...model,
        provider,
        name: model.name.replace("(latest)", "").trim(),
        latest: model.name.includes("(latest)"),
      }))
  })
}

export function resolveSessionModel(providers: Provider[], ref: ModelRef | undefined) {
  if (!ref) return undefined
  const provider = providers.find((candidate) => candidate.id === ref.providerID)
  const model = provider?.models[ref.modelID]
  if (!provider || !model) return undefined
  return { provider, model }
}
