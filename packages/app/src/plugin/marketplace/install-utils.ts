import type { ApiPluginInfo } from "@ericsanchezok/synergy-sdk/client"

/** Compare two semver strings. Returns true if a > b. */
export function semverGt(a: string, b: string): boolean {
  if (!a || !b) return false
  const aParts = a.split(".").map(Number)
  const bParts = b.split(".").map(Number)
  const len = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const aVal = aParts[i] ?? 0
    const bVal = bParts[i] ?? 0
    if (isNaN(aVal) || isNaN(bVal)) return false
    if (aVal > bVal) return true
    if (aVal < bVal) return false
  }
  return false
}

/** Check if a registry version is newer than the currently installed version. */
export function checkUpdateAvailable(registryVersion: string | undefined, installedVersion: string | null): boolean {
  if (!registryVersion || registryVersion.length === 0) return false
  if (installedVersion === null) return true
  return semverGt(registryVersion, installedVersion)
}

/** Find the installed version of a plugin given a list of loaded plugins. */
export function getInstalledVersion(plugins: ApiPluginInfo[], registryId: string): string | null {
  // First try exact pluginId match
  const exact = plugins.find((p) => p.pluginId === registryId)
  if (exact?.version && exact.version !== "0.0.0") return exact.version
  // Fallback to name match
  const byName = plugins.find((p) => p.name === registryId)
  if (byName?.version && byName.version !== "0.0.0") return byName.version
  return null
}
