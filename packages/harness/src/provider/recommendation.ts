import type { ProviderProfile } from "./profile"

export namespace ProviderRecommendation {
  export type MetadataMap = Record<string, ProviderProfile.Metadata | undefined>

  const LEVEL_WEIGHT: Record<ProviderProfile.Recommendation["level"], number> = {
    featured: 0,
    recommended: 1,
    standard: 2,
  }

  export function compare(
    profiles: MetadataMap,
    a: { id: string; name?: string; fallbackRank?: number },
    b: { id: string; name?: string; fallbackRank?: number },
  ) {
    const aRecommendation = profiles[a.id]?.recommendation
    const bRecommendation = profiles[b.id]?.recommendation
    const aLevel = LEVEL_WEIGHT[aRecommendation?.level ?? "standard"]
    const bLevel = LEVEL_WEIGHT[bRecommendation?.level ?? "standard"]
    if (aLevel !== bLevel) return aLevel - bLevel

    const aRank = aRecommendation?.rank ?? a.fallbackRank ?? Number.MAX_SAFE_INTEGER
    const bRank = bRecommendation?.rank ?? b.fallbackRank ?? Number.MAX_SAFE_INTEGER
    if (aRank !== bRank) return aRank - bRank

    return (a.name ?? a.id).localeCompare(b.name ?? b.id)
  }

  export function headline(profiles: MetadataMap, providerID: string, fallback?: string) {
    return profiles[providerID]?.recommendation?.headline ?? fallback
  }

  export function defaultModel(profiles: MetadataMap, providerID: string, fallback: string) {
    return profiles[providerID]?.recommendation?.defaultModel ?? fallback
  }

  export function cta(profiles: MetadataMap, providerID: string) {
    return profiles[providerID]?.recommendation?.cta
  }

  export function isRecommended(profiles: MetadataMap, providerID: string) {
    const level = profiles[providerID]?.recommendation?.level
    return level === "featured" || level === "recommended"
  }
}
