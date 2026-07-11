export namespace PluginArtifact {
  export const manifestFile = "plugin.json"
  export const normalizedManifestFile = "plugin.normalized.json"
  export const runtimeEntry = "runtime/index.js"
  export const integrityFile = "integrity.json"
  export const permissionsSummaryFile = "permissions.summary.json"
  export const requiredFiles = [manifestFile, integrityFile, permissionsSummaryFile] as const
  export const assetRoutePrefix = "/plugin/assets"
  export const allowedAssetRoots = ["dist", "public", "assets", "ui", "themes", "icons"] as const
}

export function normalizePluginArtifactPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized || normalized === ".") throw new Error("Plugin artifact path cannot be empty")
  if (normalized.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    throw new Error(`Plugin artifact path must be relative: ${filePath}`)
  }
  const parts = normalized.split("/").filter(Boolean)
  if (parts.includes("..")) throw new Error(`Plugin artifact path cannot escape the plugin root: ${filePath}`)
  return parts.join("/")
}

export function normalizePluginArchiveEntry(entry: string): string | undefined {
  let normalized = entry.replace(/\r$/, "").replace(/\\/g, "/")
  while (normalized.startsWith("./")) normalized = normalized.slice(2)
  normalized = normalized.replace(/\/+$/, "")
  if (!normalized || normalized === ".") return undefined
  return normalizePluginArtifactPath(normalized)
}

export function pluginArtifactAssetRoot(filePath: string): string {
  return normalizePluginArtifactPath(filePath).split("/")[0] ?? ""
}

export function isAllowedPluginAssetPath(filePath: string): boolean {
  try {
    const root = pluginArtifactAssetRoot(filePath)
    return (PluginArtifact.allowedAssetRoots as readonly string[]).includes(root)
  } catch {
    return false
  }
}

export function pluginAssetUrl(pluginId: string, versionHash: string, filePath: string): string {
  const normalized = normalizePluginArtifactPath(filePath)
  const encodedPath = normalized
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `${PluginArtifact.assetRoutePrefix}/${encodeURIComponent(pluginId)}/${encodeURIComponent(versionHash)}/${encodedPath}`
}
