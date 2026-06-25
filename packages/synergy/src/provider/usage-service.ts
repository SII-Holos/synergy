import { Config } from "@/config/config"
import { AccountUsage } from "./usage"
import { registerBuiltinProviderProfiles } from "./builtin"
import { Provider } from "./provider"
import { ProviderProfile } from "./profile"

export namespace ProviderUsage {
  export async function get(providerID: string): Promise<AccountUsage.Snapshot> {
    registerBuiltinProviderProfiles()
    const profile = ProviderProfile.get(providerID)
    if (!profile?.fetchUsage) {
      return AccountUsage.unavailable(providerID, "This provider does not expose account usage through Synergy.")
    }
    return profile.fetchUsage()
  }

  export async function all(): Promise<Record<string, AccountUsage.Snapshot>> {
    const config = await Config.current()
    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
    const providers = await Provider.list()
    const result: Record<string, AccountUsage.Snapshot> = {}
    for (const providerID of Object.keys(providers)) {
      if (disabled.has(providerID)) continue
      if (enabled && !enabled.has(providerID)) continue
      const profile = ProviderProfile.get(providerID)
      if (!profile?.fetchUsage) continue
      result[providerID] = await get(providerID)
    }
    return result
  }
}
