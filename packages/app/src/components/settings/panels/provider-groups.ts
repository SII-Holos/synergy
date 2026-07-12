import type { ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import { providerNeedsAction } from "@/components/provider/provider-auth-presentation"

export type GroupableProvider = {
  id: string
  connected: boolean
  health?: ProviderAuthHealth
}

export function groupProviderConnections<T extends GroupableProvider>(
  providers: T[],
  recommended: { has(providerID: string): boolean },
) {
  const result = {
    needsAttention: [] as T[],
    recommended: [] as T[],
    connected: [] as T[],
    other: [] as T[],
  }
  for (const provider of providers) {
    if (providerNeedsAction(provider.health)) {
      result.needsAttention.push(provider)
    } else if (recommended.has(provider.id)) {
      result.recommended.push(provider)
    } else if (provider.connected) {
      result.connected.push(provider)
    } else {
      result.other.push(provider)
    }
  }
  return result
}
