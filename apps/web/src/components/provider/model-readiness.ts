import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk/client"

/** App-wide answer to "is at least one model usable right now", derived from the global provider snapshot. */
export type ModelReadiness =
  | { state: "ready" }
  | { state: "not-configured" }
  | { state: "needs-attention"; providerIDs: string[] }
  | { state: "restricted"; providerIDs: string[] }

export function resolveModelReadiness(provider: ProviderListResponse): ModelReadiness {
  const connected = provider.connected ?? []
  const availability = provider.runtimeAvailability ?? {}
  const authHealth = provider.authHealth ?? {}

  if (connected.some((providerID) => availability[providerID]?.available === true)) return { state: "ready" }
  if (connected.length === 0) return { state: "not-configured" }

  const blocked = connected.filter((providerID) => availability[providerID]?.available !== true).sort()
  const needsAttention = blocked.filter((providerID) => {
    const status = authHealth[providerID]?.status
    return status === "action_required" || status === "exhausted"
  })
  if (needsAttention.length > 0) return { state: "needs-attention", providerIDs: needsAttention }

  return { state: "restricted", providerIDs: blocked }
}
