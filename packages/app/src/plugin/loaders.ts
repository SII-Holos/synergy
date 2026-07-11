import * as SolidRuntime from "solid-js"
import * as SolidStoreRuntime from "solid-js/store"
import * as SolidWebRuntime from "solid-js/web"
import * as SolidHRuntime from "solid-js/h"
import * as SolidJsxRuntime from "solid-js/h/jsx-runtime"
import {
  PLUGIN_SOLID_RUNTIME_KEY,
  rewritePluginSolidImports,
  hasUnsupportedSolidRuntimeImport,
  hasBundledSolidRuntime,
} from "@ericsanchezok/synergy-plugin/loader"
import { PLUGIN_UI_API_VERSION } from "@ericsanchezok/synergy-plugin/version"

type SharedSolidRuntime = {
  solid: typeof SolidRuntime
  web: typeof SolidWebRuntime
  store: typeof SolidStoreRuntime
  h: typeof SolidHRuntime
  jsx: typeof SolidJsxRuntime
}

type SharedSolidRuntimeName = keyof SharedSolidRuntime

const SHARED_SOLID_IMPORTS: Record<string, SharedSolidRuntimeName> = {
  "solid-js": "solid",
  "solid-js/web": "web",
  "solid-js/store": "store",
  "solid-js/h": "h",
  "solid-js/h/jsx-runtime": "jsx",
  "solid-js/h/jsx-dev-runtime": "jsx",
}

function sharedSolidRuntime(): SharedSolidRuntime {
  const global = globalThis as typeof globalThis & { [PLUGIN_SOLID_RUNTIME_KEY]?: SharedSolidRuntime }
  global[PLUGIN_SOLID_RUNTIME_KEY] ??= {
    solid: SolidRuntime,
    web: SolidWebRuntime,
    store: SolidStoreRuntime,
    h: SolidHRuntime,
    jsx: SolidJsxRuntime,
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
 * Load a single named export from a Tier 2 plugin's UI bundle.
 *
 * Verifies the plugin's required UI API version against the host's version
 * before importing. Throws if the versions are incompatible.
 *
 * The Synergy server rewrites Solid runtime imports in plugin UI bundles so
 * they resolve against the host's shared runtime. The client still defensively
 * validates and rewrites here as a fallback for older servers or local dev
 * proxies that may serve the raw bundle.
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
        `Plugin ${pluginId} imports an unsupported Solid runtime subpath. Use solid-js, solid-js/web, solid-js/store, solid-js/h, solid-js/h/jsx-runtime, or solid-js/h/jsx-dev-runtime.`,
      )
    }

    // If the server already rewrote the bundle, import the original URL directly.
    // Otherwise fall back to a client-side blob URL (acceptable in non-CSP contexts).
    const alreadyRewritten = !source.includes(`from "solid-js`) && !source.includes(`from 'solid-js`)
    const moduleUrl = alreadyRewritten
      ? assetsBaseUrl
      : URL.createObjectURL(
          new Blob([`${rewritePluginSolidImports(source)}\n//# sourceURL=${assetsBaseUrl}`], {
            type: "text/javascript",
          }),
        )

    const mod = (await import(/* @vite-ignore */ moduleUrl)) as Record<string, unknown>
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
