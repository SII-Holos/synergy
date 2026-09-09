import * as SolidRuntime from "solid-js"
import * as SolidStoreRuntime from "solid-js/store"
import * as SolidWebRuntime from "solid-js/web"
import { PLUGIN_SOLID_RUNTIME_KEY } from "@ericsanchezok/synergy-plugin/loader"
import { PLUGIN_UI_API_VERSION } from "@ericsanchezok/synergy-plugin/version"
import { pluginAssetIntegrity } from "./asset-integrity"
import { importPluginUIModule } from "./module-import"

function sharedSolidRuntime() {
  const global = globalThis as typeof globalThis & {
    [PLUGIN_SOLID_RUNTIME_KEY]?: {
      solid: typeof SolidRuntime
      web: typeof SolidWebRuntime
      store: typeof SolidStoreRuntime
    }
  }
  global[PLUGIN_SOLID_RUNTIME_KEY] ??= { solid: SolidRuntime, web: SolidWebRuntime, store: SolidStoreRuntime }
}

/** Current UI API version this host supports. */
export const CURRENT_UI_API_VERSION = PLUGIN_UI_API_VERSION

/** Check if a plugin's required UI API version is compatible with the host. */
export function isCompatibleUIVersion(pluginVersion: string, hostVersion: string): boolean {
  if (!/^\d+\.\d+$/.test(pluginVersion) || !/^\d+\.\d+$/.test(hostVersion)) return false
  const [pluginMajor] = pluginVersion.split(".").map(Number)
  const [hostMajor] = hostVersion.split(".").map(Number)
  return pluginMajor === hostMajor
}

type PluginModule = Record<string, unknown>

function validateVersion(pluginId: string, uiApiVersion: string | undefined) {
  const requiredVersion = uiApiVersion ?? "4.0"
  if (!isCompatibleUIVersion(requiredVersion, CURRENT_UI_API_VERSION)) {
    throw new Error(
      `Plugin ${pluginId} requires UI API ${requiredVersion} but host is ${CURRENT_UI_API_VERSION}. Rebuild the plugin for the current UI API.`,
    )
  }
}

export function createPluginExportLoader(importModule = importPluginUIModule) {
  const modules = new Map<string, Promise<PluginModule>>()
  const controller = new AbortController()
  let disposed = false
  const assertActive = () => {
    if (disposed) throw new Error("Plugin UI loader is disposed")
  }
  return {
    async load<T = unknown>(
      pluginId: string,
      assetUrl: string,
      exportName: string,
      uiApiVersion: string | undefined,
      artifactHash?: string,
    ): Promise<{ default: T }> {
      assertActive()
      validateVersion(pluginId, uiApiVersion)
      const key = JSON.stringify([pluginId, assetUrl, artifactHash, uiApiVersion])
      let pending = modules.get(key)
      if (!pending) {
        pluginAssetIntegrity(artifactHash)
        sharedSolidRuntime()
        pending = importModule({ pluginId, url: assetUrl, sha256: artifactHash!, signal: controller.signal }).catch(
          (error: unknown) => {
            modules.delete(key)
            assertActive()
            throw new Error(
              `Failed to load plugin ${pluginId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          },
        )
        modules.set(key, pending)
      }
      const module = await pending
      assertActive()
      const exported = module[exportName]
      if (exported === undefined) throw new Error(`Export "${exportName}" not found in plugin ${pluginId} bundle`)
      return { default: exported as T }
    },
    dispose() {
      disposed = true
      controller.abort()
      modules.clear()
    },
  }
}
