import { pluginMarketplace } from "@/locales/messages"
import type { MessageDescriptor } from "@lingui/core"
import type { InstalledPlugin } from "./types"

export type MarketplaceView = "discover" | "installed" | "development"

export const MARKETPLACE_NAV_ITEMS: ReadonlyArray<{ id: MarketplaceView; label: MessageDescriptor }> = [
  { id: "discover", label: pluginMarketplace.navDiscover },
  { id: "installed", label: pluginMarketplace.navInstalled },
  { id: "development", label: pluginMarketplace.navDevelopment },
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

export function installationLabel(plugin: InstalledPlugin): MessageDescriptor {
  const installation = plugin.installation
  if (installation.kind === "directory") return pluginMarketplace.installationDirectory
  if (installation.kind === "archive") return pluginMarketplace.installationArchive
  if (installation.kind === "registry") {
    return installation.registry === "official"
      ? pluginMarketplace.installationOfficialRegistry
      : pluginMarketplace.installationLocalRegistry
  }
  if (installation.kind === "package") {
    return { ...pluginMarketplace.installationPackage, values: { source: installation.source.toUpperCase() } }
  }
  return pluginMarketplace.installationBuiltIn
}

export function installedPluginFromSnapshot(
  pluginId: string,
  plugins: InstalledPlugin[] | undefined,
  openingSnapshot?: InstalledPlugin,
): InstalledPlugin | undefined {
  if (!plugins) return openingSnapshot
  return plugins.find((plugin) => plugin.id === pluginId)
}
