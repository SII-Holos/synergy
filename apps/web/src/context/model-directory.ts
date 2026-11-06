import type {
  ProviderListResponse,
  ProviderDirectoryModel,
  ProviderDirectoryPage,
} from "@ericsanchezok/synergy-sdk/client"

export type ProviderSnapshot = ProviderListResponse & {
  version?: string
  complete?: boolean
  resolvedModels?: string[]
}

export function mergeModelDirectory(
  current: ProviderSnapshot,
  page: Pick<ProviderDirectoryPage, "version" | "models">,
): ProviderSnapshot {
  if (current.version && current.version !== page.version) return current
  const entries = new Map<string, ProviderDirectoryModel[]>()
  for (const entry of page.models) {
    const items = entries.get(entry.providerID) ?? []
    items.push(entry)
    entries.set(entry.providerID, items)
  }
  return {
    ...current,
    version: page.version,
    all: current.all.map((provider) => ({
      ...provider,
      models: {
        ...provider.models,
        ...Object.fromEntries((entries.get(provider.id) ?? []).map((entry) => [entry.model.id, entry.model])),
      },
    })),
  }
}

export function mergeProviderSelection(current: ProviderSnapshot, incoming: ProviderSnapshot): ProviderSnapshot {
  if (!current.version || current.version !== incoming.version || incoming.complete !== false) return incoming
  const providers = new Map(current.all.map((provider) => [provider.id, provider]))
  return {
    ...incoming,
    complete: current.complete ?? incoming.complete,
    resolvedModels: [...new Set([...(current.resolvedModels ?? []), ...(incoming.resolvedModels ?? [])])],
    all: incoming.all.map((provider) => ({
      ...provider,
      models: { ...providers.get(provider.id)?.models, ...provider.models },
    })),
  }
}
