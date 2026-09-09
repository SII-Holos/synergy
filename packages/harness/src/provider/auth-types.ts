import type { Auth } from "./api-key"
import type { Provider } from "./provider"
import type { AuthHook as ProviderAuthHook } from "@ericsanchezok/synergy-util/provider-auth"
export type { AuthImportResult, AuthOuathResult, AuthPrompt } from "@ericsanchezok/synergy-util/provider-auth"
export type AuthHook = ProviderAuthHook<Auth.Info, Provider.Info>
