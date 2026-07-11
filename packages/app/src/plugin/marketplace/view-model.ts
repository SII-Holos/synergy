import type { InstalledPlugin } from "./types"

export type MarketplaceView = "discover" | "installed" | "development"

export const MARKETPLACE_NAV_ITEMS: ReadonlyArray<{ id: MarketplaceView; label: string }> = [
  { id: "discover", label: "Discover" },
  { id: "installed", label: "Installed" },
  { id: "development", label: "Development" },
]

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

export function isDevelopmentPlugin(plugin: InstalledPlugin): boolean {
  return plugin.installation.kind === "directory"
}

export function installedPluginsForView(
  plugins: InstalledPlugin[],
  view: Exclude<MarketplaceView, "discover">,
  query: string,
): InstalledPlugin[] {
  const q = normalize(query)
  return plugins.filter((plugin) => {
    if (view === "development" && !isDevelopmentPlugin(plugin)) return false
    if (!q) return true
    const installation = plugin.installation
    const installationText =
      installation.kind === "directory" || installation.kind === "archive"
        ? installation.path
        : installation.kind === "registry"
          ? `${installation.registry} registry`
          : installation.kind === "package"
            ? installation.source
            : installation.kind
    return [plugin.id, plugin.name, plugin.version, installationText].some((value) => normalize(value).includes(q))
  })
}

export function installationLabel(plugin: InstalledPlugin): string {
  const installation = plugin.installation
  if (installation.kind === "directory") return "Local directory"
  if (installation.kind === "archive") return "Local archive"
  if (installation.kind === "registry") {
    return installation.registry === "official" ? "Official registry" : "Local registry"
  }
  if (installation.kind === "package") return `${installation.source.toUpperCase()} package`
  return "Built in"
}
