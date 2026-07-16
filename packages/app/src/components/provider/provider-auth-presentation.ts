import type {
  AccountUsageSnapshot,
  ProviderAuthHealth,
  ProviderRuntimeAvailability,
} from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"

export function providerNeedsAction(health?: ProviderAuthHealth, usageSnapshot?: AccountUsageSnapshot) {
  if (health?.status === "action_required") return true
  if (health?.status === "exhausted") return false
  return usageSnapshot?.reloginRequired === true
}

export function providerStatusLabel(
  health?: ProviderAuthHealth,
  availability?: ProviderRuntimeAvailability,
): MessageDescriptor {
  if (health?.status === "action_required") {
    if (health.recovery === "update_environment")
      return { id: "provider.status.updateEnvironment", message: "Update environment" }
    if (health.authKind === "api_key")
      return { id: "provider.status.replaceCredentials", message: "Replace credentials" }
    return { id: "provider.status.signInRequired", message: "Sign-in required" }
  }
  if (health?.status === "exhausted")
    return { id: "provider.status.temporarilyUnavailable", message: "Temporarily unavailable" }
  if (availability?.reason === "fallback_unverified")
    return { id: "provider.status.fallbackCatalog", message: "Fallback catalog" }
  if (health?.status === "connected")
    return availability?.available === false
      ? { id: "provider.status.unavailable", message: "Unavailable" }
      : { id: "provider.status.connected", message: "Connected" }
  return { id: "provider.status.notConnected", message: "Not connected" }
}

export function providerRecoveryCopy(
  providerName: string,
  health?: ProviderAuthHealth,
  environment: string[] = [],
): MessageDescriptor {
  if (health?.recovery === "update_environment") {
    const names = environment.length > 0 ? environment.join(" or ") : "the configured environment variable"
    return {
      id: "provider.recovery.updateEnv",
      message: "{providerName} rejected credentials from {names}. Update the environment and restart the server.",
      values: { providerName, names },
    }
  }
  if (health?.authKind === "api_key") {
    return {
      id: "provider.recovery.apiKey",
      message: "{providerName} rejected this API key. Replace it to restore models and usage.",
      values: { providerName },
    }
  }
  return {
    id: "provider.recovery.reconnect",
    message: "{providerName} rejected these credentials. Reconnect to restore models and usage.",
    values: { providerName },
  }
}

export function providerRecoveryTarget(providerID: string) {
  return providerID === "github"
    ? ({ section: "github" as const, providerID } satisfies ProviderRecoveryTarget)
    : ({ section: "providers" as const, providerID } satisfies ProviderRecoveryTarget)
}

export function providerAuthTone(health?: ProviderAuthHealth) {
  if (health?.status === "action_required") return "warning" as const
  if (health?.status === "exhausted") return "muted" as const
  if (health?.status === "connected") return "success" as const
  return "muted" as const
}

export function providerRecoveryActionLabel(health?: ProviderAuthHealth): MessageDescriptor {
  if (health?.recovery === "update_environment") return { id: "provider.action.viewSetup", message: "View setup" }
  if (health?.authKind === "api_key")
    return { id: "provider.action.replaceCredentials", message: "Replace credentials" }
  return { id: "provider.action.reconnect", message: "Reconnect" }
}

export function providerUsageStatusLabel(
  health?: ProviderAuthHealth,
  snapshot?: AccountUsageSnapshot,
): MessageDescriptor {
  if (providerNeedsAction(health, snapshot))
    return health ? providerStatusLabel(health) : { id: "provider.status.signInRequired", message: "Sign-in required" }
  if (health?.status === "exhausted")
    return { id: "provider.usage.temporarilyUnavailable", message: "Temporarily unavailable" }
  if (snapshot?.status === "error") return { id: "provider.usage.retry", message: "Retry" }
  if (snapshot?.status === "unavailable") return { id: "provider.usage.unavailable", message: "Unavailable" }
  if (snapshot?.status === "available") return { id: "provider.usage.available", message: "Available" }
  return providerStatusLabel(health)
}

export type ProviderRecoveryTarget = {
  section: "providers" | "github"
  providerID?: string
}
