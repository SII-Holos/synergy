import * as SolidRuntime from "solid-js"
import * as SolidStoreRuntime from "solid-js/store"
import * as SolidWebRuntime from "solid-js/web"
import {
  PLUGIN_SOLID_RUNTIME_KEY,
  hasUnsupportedSolidRuntimeImport,
  hasBundledSolidRuntime,
  hasUnlinkedSolidRuntimeImport,
} from "@ericsanchezok/synergy-plugin/loader"
import { PLUGIN_UI_API_VERSION } from "@ericsanchezok/synergy-plugin/version"

type SharedSolidRuntime = {
  solid: typeof SolidRuntime
  web: typeof SolidWebRuntime
  store: typeof SolidStoreRuntime
}

function sharedSolidRuntime(): SharedSolidRuntime {
  const global = globalThis as typeof globalThis & { [PLUGIN_SOLID_RUNTIME_KEY]?: SharedSolidRuntime }
  global[PLUGIN_SOLID_RUNTIME_KEY] ??= {
    solid: SolidRuntime,
    web: SolidWebRuntime,
    store: SolidStoreRuntime,
  }
  return global[PLUGIN_SOLID_RUNTIME_KEY]
}

/** Current UI API version this host supports. */
export const CURRENT_UI_API_VERSION = PLUGIN_UI_API_VERSION

/** Check if a plugin's required UI API version is compatible with the host. */
export function isCompatibleUIVersion(pluginVersion: string, hostVersion: string): boolean {
  const [pluginMajor] = pluginVersion.split(".").map(Number)
  const [hostMajor] = hostVersion.split(".").map(Number)
  return pluginMajor === hostMajor
}

/**
 * Load a single named export from a trusted plugin UI bundle.
 *
 * Verifies the plugin's required UI API version against the host's version
 * before importing. Throws if the versions are incompatible.
 *
 * plugin-kit compiles TSX with the Solid compiler and binds the generated DOM
 * instructions to the host runtime before hashing the bundle. The host rejects
 * bundles that bypass that build contract.
 *
 * @param pluginId        - Unique plugin identifier
 * @param assetsBaseUrl   - Fully resolved URL for the plugin UI asset.
 * @param exportName      - Named export to pull from the bundle (use "default" for default export)
 * @param uiApiVersion    - Minimum UI API version the plugin requires (e.g. "3.0")
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

  sharedSolidRuntime()

  try {
    const response = await fetch(assetsBaseUrl)
    if (!response.ok) throw new Error(`Failed to fetch plugin UI bundle: HTTP ${response.status}`)

    const source = await response.text()
    if (hasBundledSolidRuntime(source)) {
      throw new Error(`Plugin ${pluginId} bundles Solid runtime. Rebuild it with synergy-plugin build.`)
    }
    if (hasUnsupportedSolidRuntimeImport(source)) {
      throw new Error(
        `Plugin ${pluginId} imports an unsupported Solid runtime subpath. Use solid-js, solid-js/web, or solid-js/store.`,
      )
    }
    if (hasUnlinkedSolidRuntimeImport(source)) {
      throw new Error(`Plugin ${pluginId} UI bundle is not bound to the Synergy Solid runtime.`)
    }

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
