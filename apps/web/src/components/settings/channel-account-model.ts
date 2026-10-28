import type { ProviderGroup } from "./types"

export function channelAccountVariantKeys(modelRef: string, providers: ProviderGroup[]): string[] {
  const separator = modelRef.indexOf("/")
  if (separator === -1) return []

  const providerID = modelRef.slice(0, separator)
  const modelID = modelRef.slice(separator + 1)
  const provider = providers.find((item) => item.providerId === providerID)
  return provider?.models.find((item) => item.id === modelID)?.variantKeys ?? []
}
