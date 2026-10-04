import type { ProviderModelCatalogState } from "@ericsanchezok/synergy-sdk/client"

export function providerCatalogPresentation(catalog?: ProviderModelCatalogState, refreshing = false) {
  const verifiedAt = catalog?.lastVerifiedAt
  if (refreshing || catalog?.refreshing) return { status: "loading", tone: "neutral", verifiedAt } as const
  if (catalog?.failure) return { status: "failed", tone: "warning", verifiedAt } as const
  if (!catalog) return { status: "unavailable", tone: "neutral", verifiedAt } as const
  if (catalog.source === "bundled") return { status: "bundled", tone: "neutral", verifiedAt } as const
  return { status: catalog.source === "live" ? "updated" : "cached", tone: "neutral", verifiedAt } as const
}
