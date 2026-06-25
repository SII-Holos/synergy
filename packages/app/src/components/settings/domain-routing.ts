import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { FIELD_SAVE_STRATEGY, type SettingsFieldStrategy } from "./catalog"

export function buildFieldDomainMap(domains: ConfigDomainSummary[]): Map<string, ConfigDomainSummary["id"]> {
  const result = new Map<string, ConfigDomainSummary["id"]>()
  for (const domain of domains) {
    for (const key of domain.ownedKeys) result.set(key, domain.id)
  }
  return result
}

export function groupPatchByDomain(
  patch: Record<string, unknown>,
  domains: ConfigDomainSummary[],
): Map<ConfigDomainSummary["id"], Record<string, unknown>> {
  const fieldDomain = buildFieldDomainMap(domains)
  const grouped = new Map<ConfigDomainSummary["id"], Record<string, unknown>>()
  for (const [key, value] of Object.entries(patch)) {
    const domain = fieldDomain.get(key)
    if (!domain) throw new Error(`Settings field "${key}" is not owned by a config domain`)
    const domainPatch = grouped.get(domain) ?? {}
    domainPatch[key] = value
    grouped.set(domain, domainPatch)
  }
  return grouped
}

export function strategyForPatch(patch: Record<string, unknown>): SettingsFieldStrategy[] {
  return Object.keys(patch).map((key) => {
    const strategy = FIELD_SAVE_STRATEGY[key]
    if (!strategy) throw new Error(`Settings field "${key}" does not define a save strategy`)
    return strategy
  })
}
