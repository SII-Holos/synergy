export type ProviderRecommendationMetadata = {
  id: string
  name: string
  displayName?: string
  description?: string
  signupUrl?: string
  authKind?: string
  environment?: string[]
  recommendation?: {
    level: "featured" | "recommended" | "standard"
    rank?: number
    headline?: string
    reason?: string
    cta?: {
      kind: "external"
      label: string
      url: string
    }
    defaultModel?: string
  }
}

export type ProviderRecommendationMap = Record<string, ProviderRecommendationMetadata | undefined>

const LEVEL_WEIGHT: Record<NonNullable<ProviderRecommendationMetadata["recommendation"]>["level"], number> = {
  featured: 0,
  recommended: 1,
  standard: 2,
}

export function providerRecommendation(profiles: ProviderRecommendationMap | undefined, providerID: string) {
  return profiles?.[providerID]?.recommendation
}

export function isRecommendedProvider(profiles: ProviderRecommendationMap | undefined, providerID: string) {
  const level = providerRecommendation(profiles, providerID)?.level
  return level === "featured" || level === "recommended"
}

export function providerConnectCopy(providerID: string, profiles?: ProviderRecommendationMap, fallbackName?: string) {
  return (
    providerRecommendation(profiles, providerID)?.headline ??
    (fallbackName ? `Connect ${fallbackName}` : "Connect provider")
  )
}

export function providerConnectReason(providerID: string, profiles?: ProviderRecommendationMap) {
  return providerRecommendation(profiles, providerID)?.reason ?? profiles?.[providerID]?.description
}

export function providerCTA(providerID: string, profiles?: ProviderRecommendationMap) {
  return providerRecommendation(profiles, providerID)?.cta
}

export function compareProviderIDs(
  profiles: ProviderRecommendationMap | undefined,
  a: { id: string; name?: string },
  b: { id: string; name?: string },
) {
  const aRecommendation = providerRecommendation(profiles, a.id)
  const bRecommendation = providerRecommendation(profiles, b.id)
  const aLevel = LEVEL_WEIGHT[aRecommendation?.level ?? "standard"]
  const bLevel = LEVEL_WEIGHT[bRecommendation?.level ?? "standard"]
  if (aLevel !== bLevel) return aLevel - bLevel

  const aRank = aRecommendation?.rank ?? Number.MAX_SAFE_INTEGER
  const bRank = bRecommendation?.rank ?? Number.MAX_SAFE_INTEGER
  if (aRank !== bRank) return aRank - bRank

  return (a.name ?? a.id).localeCompare(b.name ?? b.id)
}
