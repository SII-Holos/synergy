import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk"

type Provider = ProviderListResponse["all"][number]
type Model = Provider["models"][string]

export type ModelRef = { providerID: string; modelID: string }
export type QuickSwitcherPreference = ModelRef & { state: "add" | "remove" }
export type SelectableConnectedModel = Omit<Model, "provider" | "name"> & {
  provider: Provider
  name: string
  latest: boolean
}

export function isSelectableModel(model: Pick<Model, "status" | "catalogState">) {
  return model.status !== "deprecated" && model.catalogState !== "retained"
}

export function listSelectableConnectedModels(
  providers: readonly Provider[],
  connectedProviderIDs: readonly string[],
  providerID?: string,
): SelectableConnectedModel[] {
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

function compareRecommendationCandidates(a: SelectableConnectedModel, b: SelectableConnectedModel) {
  const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  const releaseDate = compareText(String(b.release_date ?? ""), String(a.release_date ?? ""))
  if (releaseDate !== 0) return releaseDate

  const name = compareText(a.name, b.name)
  if (name !== 0) return name
  return compareText(a.id, b.id)
}

export function recommendQuickSwitcherModels(
  models: readonly SelectableConnectedModel[],
  defaults: Readonly<Record<string, string>>,
): ModelRef[] {
  const result: ModelRef[] = []
  const seen = new Set<string>()
  const push = (model: SelectableConnectedModel | undefined) => {
    if (!model) return
    const ref = { providerID: model.provider.id, modelID: model.id }
    const key = `${ref.providerID}:${ref.modelID}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(ref)
  }
  const newest = (candidates: SelectableConnectedModel[]) => [...candidates].sort(compareRecommendationCandidates)[0]

  const providerIDs = [...new Set(models.map((model) => model.provider.id))].sort()
  for (const providerID of providerIDs) {
    const providerModels = models.filter((model) => model.provider.id === providerID)
    const defaultModelID = defaults[providerID]
    push(providerModels.find((model) => model.id === defaultModelID))
    push(newest(providerModels.filter((model) => model.capabilities.reasoning)))
    push(newest(providerModels.filter((model) => (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0)))
    push(
      newest(
        providerModels.filter(
          (model) => model.capabilities.input.image || model.capabilities.input.pdf || model.capabilities.input.video,
        ),
      ),
    )
  }

  return result
}

function modelRefKey(model: ModelRef) {
  return `${model.providerID}:${model.modelID}`
}

export function resolveQuickSwitcherModels(
  recommended: readonly ModelRef[],
  preferences: readonly QuickSwitcherPreference[],
): ModelRef[] {
  const preferencesByModel = new Map(preferences.map((item) => [modelRefKey(item), item.state]))
  const result = recommended.filter((model) => preferencesByModel.get(modelRefKey(model)) !== "remove")
  const seen = new Set(result.map(modelRefKey))

  for (const preference of preferences) {
    const key = modelRefKey(preference)
    if (preferencesByModel.get(key) !== "add" || seen.has(key)) continue
    seen.add(key)
    result.push({ providerID: preference.providerID, modelID: preference.modelID })
  }

  return result
}

type QuickSwitcherDisplayModel = {
  id: string
  name: string
  provider: { id: string; name: string }
}

export function listQuickSwitcherEntries<T extends QuickSwitcherDisplayModel>(
  configured: readonly T[],
  recent: readonly T[],
  providerID?: string,
): Array<T & { group: string; listKey: string }> {
  const matchesProvider = (model: T) => !providerID || model.provider.id === providerID
  const configuredEntries = configured
    .filter(matchesProvider)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => ({
      ...model,
      group: model.provider.name,
      listKey: `${model.provider.id}:${model.id}`,
    }))
  const recentEntries = recent.filter(matchesProvider).map((model) => ({
    ...model,
    group: "Recent",
    listKey: `recent:${model.provider.id}:${model.id}`,
  }))

  return [...recentEntries, ...configuredEntries]
}

export function resolveSessionModel(providers: Provider[], ref: ModelRef | undefined) {
  if (!ref) return undefined
  const provider = providers.find((candidate) => candidate.id === ref.providerID)
  const model = provider?.models[ref.modelID]
  if (!provider || !model) return undefined
  return { provider, model }
}
