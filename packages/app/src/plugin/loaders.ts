/** Current UI API version this host supports. */
export const CURRENT_UI_API_VERSION = "2.0.0"

/** Check if a plugin's required UI API version is compatible with the host. */
export function isCompatibleUIVersion(pluginVersion: string, hostVersion: string): boolean {
  const [pluginMajor] = pluginVersion.split(".").map(Number)
  const [hostMajor] = hostVersion.split(".").map(Number)
  return pluginMajor === hostMajor
}

/**
 * Load a single named export from a Tier 2 plugin's UI bundle.
 *
 * Verifies the plugin's required UI API version against the host's version
 * before importing. Throws if the versions are incompatible.
 *
 * @param pluginId        - Unique plugin identifier
 * @param assetsBaseUrl   - Fully resolved URL for the plugin UI asset.
 * @param exportName      - Named export to pull from the bundle (use "default" for default export)
 * @param uiApiVersion    - Minimum UI API version the plugin requires (e.g. "2.0.0")
 */
export async function loadPluginExport<T = unknown>(
  pluginId: string,
  assetsBaseUrl: string,
  exportName: string,
  uiApiVersion: string,
): Promise<{ default: T }> {
  if (uiApiVersion && !isCompatibleUIVersion(uiApiVersion, CURRENT_UI_API_VERSION)) {
    throw new Error(`Plugin ${pluginId} requires UI API ${uiApiVersion} but host is ${CURRENT_UI_API_VERSION}`)
  }
  try {
    const mod = (await import(/* @vite-ignore */ assetsBaseUrl)) as Record<string, unknown>
    const exported = mod[exportName]
    if (exported === undefined) {
      throw new Error(`Export "${exportName}" not found in plugin ${pluginId} bundle at ${assetsBaseUrl}`)
    }
    return { default: exported as T }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Export ")) throw err
    throw new Error(
      `Failed to load plugin ${pluginId} from ${assetsBaseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
