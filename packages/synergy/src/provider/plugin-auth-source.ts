import type { AuthHook } from "@ericsanchezok/synergy-plugin/auth"
import type { ProviderProfile } from "./profile"

/**
 * S9d source inversion: the L1 provider domain reads plugin auth-provider
 * contributions — auth hooks for option loading and profile descriptors for
 * the catalog — through this registered source instead of importing the
 * plugin product domain. The L4 product manifest registers the concrete
 * source; unregistered, no plugin providers contribute.
 */
export namespace ProviderPluginAuth {
  export interface AuthProviderHookEntry {
    providerID: string
    hook: AuthHook
  }

  export interface AuthProviderProfileEntry {
    id: string
    name: string
    aliases?: string[]
    description?: string
    signupUrl?: string
    recommendation?: ProviderProfile.Profile["recommendation"]
    env?: string[]
    baseURL?: string
    modelsURL?: string
    authKind?: ProviderProfile.Profile["authKind"]
    fallbackModels?: string[]
  }

  export interface Source {
    authProviderHooks(): Promise<AuthProviderHookEntry[]>
    authProviderProfiles(): Promise<AuthProviderProfileEntry[]>
  }

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
