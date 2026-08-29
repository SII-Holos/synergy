import { ProviderPluginAuth } from "../provider/plugin-auth-source"
import { Plugin } from "./index"
import { authHook } from "./auth-provider"

/**
 * S9d source inversion: plugin auth-provider contributions flow into the L1
 * provider domain through this registered source. Loaded through
 * src/product-registration.ts.
 */
export function registerProviderPluginAuth() {
  ProviderPluginAuth.register({
    async authProviderHooks() {
      const entries = await Plugin.authProviderEntries()
      return entries.map(({ plugin, contribution }) => {
        const hook = authHook(plugin, contribution)
        return { providerID: hook.provider, hook }
      })
    },
    async authProviderProfiles() {
      const entries = await Plugin.authProviderEntries().catch(() => [])
      return entries.map(({ contribution }) => {
        const profile = contribution.provider
        return {
          id: contribution.id,
          name: profile.name,
          aliases: profile.aliases,
          description: profile.description,
          signupUrl: profile.signupUrl,
          recommendation: profile.recommendation as ProviderPluginAuth.AuthProviderProfileEntry["recommendation"],
          env: profile.env,
          baseURL: profile.baseURL,
          modelsURL: profile.modelsURL,
          authKind: profile.authKind as ProviderPluginAuth.AuthProviderProfileEntry["authKind"],
          fallbackModels: profile.fallbackModels,
        }
      })
    },
  })
}
