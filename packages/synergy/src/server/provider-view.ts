import { mapValues } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { ProviderCatalog } from "../provider/catalog"
import { Auth } from "../provider/api-key"
import { ProviderProfile } from "../provider/profile"
import { GitHubProvider } from "../provider/github"
import { ProviderAuthHealth } from "../provider/auth-health"

export const ProviderRuntimeAvailability = z
  .object({
    providerID: z.string(),
    available: z.boolean(),
    reason: z
      .enum([
        "connected",
        "not_connected",
        "disabled",
        "no_models",
        "authentication_required",
        "exhausted",
        "fallback_unverified",
      ])
      .optional(),
    healthCheck: z.enum(["models", "none"]).optional(),
    modelCount: z.number(),
  })
  .meta({ ref: "ProviderRuntimeAvailability" })

export const ProviderListResponse = z
  .object({
    all: Provider.Info.array(),
    default: z.record(z.string(), z.string()),
    connected: z.array(z.string()),
    configProviders: z.array(z.string()),
    catalogProviders: z.array(z.string()),
    profiles: z.record(z.string(), ProviderProfile.Metadata),
    authHealth: z.record(z.string(), ProviderAuthHealth.Info),
    runtimeAvailability: z.record(z.string(), ProviderRuntimeAvailability),
  })
  .meta({ ref: "ProviderListResponse" })

export async function listProvidersForClient(): Promise<z.infer<typeof ProviderListResponse>> {
  const config = await Config.current()
  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

  const allProviders = await ProviderCatalog.resolve({ config, includeLive: false })
  const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
  for (const [key, value] of Object.entries(allProviders)) {
    if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filteredProviders[key] = value
  }

  const connected = await Provider.list()
  const configProviders = Object.entries(connected)
    .filter(([id, provider]) => provider.source === "config" && !allProviders[id])
    .map(([id]) => id)
  const providers = Object.assign(
    mapValues(filteredProviders, (provider) => Provider.fromModelsDevProvider(provider)),
    connected,
  )
  const profiles = Object.fromEntries(
    Object.entries(providers).map(([providerID, provider]) => [
      providerID,
      ProviderCatalog.providerMetadata(filteredProviders[providerID] ?? provider),
    ]),
  )
  const entries = await Auth.entries()
  const healthProviderIDs = new Set([...Object.keys(providers), ...Object.keys(entries), GitHubProvider.PROVIDER_ID])
  const authHealth = Object.fromEntries(
    [...healthProviderIDs].map((providerID) => {
      const health = ProviderAuthHealth.fromEntry(providerID, entries[providerID])
      if (health.status !== "not_configured") return [providerID, health]
      const provider = providers[providerID]
      const profile = ProviderProfile.get(providerID)
      const githubEnvironment =
        providerID === GitHubProvider.PROVIDER_ID &&
        !!(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim())
      const runtimeConnected = Object.prototype.hasOwnProperty.call(connected, providerID)
      if (!runtimeConnected && !githubEnvironment) return [providerID, health]
      const environment = provider?.env?.some((name) => !!process.env[name]?.trim()) || githubEnvironment
      return [
        providerID,
        {
          providerID,
          status: "connected" as const,
          authKind: profile?.authKind,
          source: environment ? "env" : profile?.origin === "plugin" ? "plugin" : undefined,
        },
      ]
    }),
  )
  const runtimeAvailability = mapValues(providers, (provider) => {
    const disabledProvider = disabled.has(provider.id)
    const modelCount = Object.keys(provider.models).length
    const health = authHealth[provider.id]
    const authenticationRequired = health?.status === "action_required"
    const credentialExhausted = health?.status === "exhausted"
    const available =
      !disabledProvider &&
      !authenticationRequired &&
      !credentialExhausted &&
      Object.prototype.hasOwnProperty.call(connected, provider.id) &&
      modelCount > 0
    const profile = ProviderProfile.get(provider.id)
    const fallbackUnverified = ProviderCatalog.liveDiscoveryStatus(provider.id) === "fallback"
    return {
      providerID: provider.id,
      available,
      reason: disabledProvider
        ? ("disabled" as const)
        : authenticationRequired
          ? ("authentication_required" as const)
          : credentialExhausted
            ? ("exhausted" as const)
            : modelCount === 0
              ? ("no_models" as const)
              : fallbackUnverified && available
                ? ("fallback_unverified" as const)
                : available
                  ? ("connected" as const)
                  : ("not_connected" as const),
      healthCheck: profile?.healthCheck ?? "models",
      modelCount,
    }
  })
  const defaultModels = Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const model = Provider.sort(Object.values(provider.models))[0]
      return model ? [[providerID, model.id]] : []
    }),
  )

  return {
    all: Object.values(providers),
    default: defaultModels,
    connected: Object.keys(connected),
    configProviders,
    catalogProviders: Object.keys(filteredProviders),
    profiles,
    authHealth,
    runtimeAvailability,
  }
}
