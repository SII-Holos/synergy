import type { Auth, Provider } from "@ericsanchezok/synergy-sdk"
import type { AuthHook as ProviderAuthHook } from "@ericsanchezok/synergy-util/provider-auth"
export type { AuthImportResult, AuthOuathResult, AuthPrompt } from "@ericsanchezok/synergy-util/provider-auth"
export type AuthHook = ProviderAuthHook<Auth, Provider>
