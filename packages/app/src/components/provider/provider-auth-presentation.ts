import type {
  AccountUsageSnapshot,
  ProviderAuthHealth,
  ProviderRuntimeAvailability,
} from "@ericsanchezok/synergy-sdk/client"

export function providerNeedsAction(health?: ProviderAuthHealth, usageSnapshot?: AccountUsageSnapshot) {
  if (health?.status === "action_required") return true
  if (health?.status === "exhausted") return false
  return usageSnapshot?.reloginRequired === true
}

export function providerStatusLabel(health?: ProviderAuthHealth, availability?: ProviderRuntimeAvailability): string {
  if (health?.status === "action_required") {
    if (health.recovery === "update_environment") return "Update environment"
    if (health.authKind === "api_key") return "Replace credentials"
    return "Sign-in required"
  }
  if (health?.status === "exhausted") return "Temporarily unavailable"
  if (availability?.reason === "fallback_unverified") return "Fallback catalog"
  if (health?.status === "connected") return availability?.available === false ? "Unavailable" : "Connected"
  return "Not connected"
}

export function providerRecoveryCopy(
  providerName: string,
  health?: ProviderAuthHealth,
  environment: string[] = [],
): string {
  if (health?.recovery === "update_environment") {
    const names = environment.length > 0 ? environment.join(" or ") : "the configured environment variable"
    return `${providerName} rejected credentials from ${names}. Update the environment and restart the server.`
  }
  if (health?.authKind === "api_key") {
    return `${providerName} rejected this API key. Replace it to restore models and usage.`
  }
  return `${providerName} rejected these credentials. Reconnect to restore models and usage.`
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

export function providerRecoveryActionLabel(health?: ProviderAuthHealth): string {
  if (health?.recovery === "update_environment") return "View setup"
  if (health?.authKind === "api_key") return "Replace credentials"
  return "Reconnect"
}

export function providerUsageStatusLabel(health?: ProviderAuthHealth, snapshot?: AccountUsageSnapshot): string {
  if (providerNeedsAction(health, snapshot)) return health ? providerStatusLabel(health) : "Sign-in required"
  if (health?.status === "exhausted") return "Temporarily unavailable"
  if (snapshot?.status === "error") return "Retry"
  if (snapshot?.status === "unavailable") return "Unavailable"
  if (snapshot?.status === "available") return "Available"
  return providerStatusLabel(health)
}

export type ProviderRecoveryTarget = {
  section: "providers" | "github"
  providerID?: string
}
