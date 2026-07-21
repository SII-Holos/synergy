import { pluginAssetUrl } from "@ericsanchezok/synergy-plugin/artifact"
import { parseTheme, type PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"
import type { PluginContribution } from "./api"
import type { IconEntry } from "./registries/icon-registry"
import { pluginSurfaceId } from "./surface-id"

export type LoadedPluginIcon = IconEntry & { pluginId: string }

export interface PluginUIAssetError {
  pluginId: string
  message: string
}

export interface PluginUIAssets {
  themes: Map<string, PluginThemeDefinition>
  icons: Map<string, LoadedPluginIcon>
  errors: PluginUIAssetError[]
}

export function resolvePluginIconReference(contribution: PluginContribution, iconName: string | undefined) {
  if (!iconName) return iconName
  const declared = contribution.contributions.some((item) => item.kind === "ui.icon" && item.id === iconName)
  return declared ? pluginSurfaceId(contribution.pluginId, iconName) : iconName
}

interface PluginUIAssetLoadOptions {
  signal?: AbortSignal
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
}

type LoadedAssetSuccess =
  | { status: "loaded"; kind: "theme"; key: string; value: PluginThemeDefinition }
  | { status: "loaded"; kind: "icon"; key: string; value: LoadedPluginIcon }
type LoadedAsset = LoadedAssetSuccess | { status: "error"; error: PluginUIAssetError }

export async function loadPluginUIAssets(
  contributions: PluginContribution[],
  options: PluginUIAssetLoadOptions = {},
): Promise<PluginUIAssets> {
  const fetcher = options.fetcher ?? fetch
  const requests: Array<Promise<LoadedAsset>> = []

  for (const contribution of contributions) {
    for (const definition of contribution.contributions) {
      if (definition.kind === "ui.theme") {
        requests.push(
          loadAsset(contribution.pluginId, `Theme "${definition.id}"`, options.signal, async () => {
            const url = pluginAssetUrl(contribution.pluginId, contribution.generation, definition.path)
            const response = await fetcher(url, { signal: options.signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const theme = parseTheme(await response.json())
            if (theme.id !== definition.id) {
              throw new Error(`theme id "${theme.id}" does not match contribution id "${definition.id}"`)
            }
            const key = pluginSurfaceId(contribution.pluginId, definition.id)
            return {
              status: "loaded" as const,
              kind: "theme" as const,
              key,
              value: {
                id: key,
                label: definition.label,
                theme,
                pluginId: contribution.pluginId,
              } satisfies PluginThemeDefinition,
            }
          }),
        )
      }

      if (definition.kind === "ui.icon") {
        requests.push(
          loadAsset(contribution.pluginId, `Icon "${definition.id}"`, options.signal, async () => {
            const url = pluginAssetUrl(contribution.pluginId, contribution.generation, definition.path)
            const response = await fetcher(url, { signal: options.signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const svgContent = await response.text()
            if (!svgContent.trim()) throw new Error("empty SVG asset")
            const key = pluginSurfaceId(contribution.pluginId, definition.id)
            return {
              status: "loaded" as const,
              kind: "icon" as const,
              key,
              value: {
                name: key,
                svgContent,
                pluginId: contribution.pluginId,
              } satisfies LoadedPluginIcon,
            }
          }),
        )
      }
    }
  }

  const themes = new Map<string, PluginThemeDefinition>()
  const icons = new Map<string, LoadedPluginIcon>()
  const errors: PluginUIAssetError[] = []
  for (const result of await Promise.all(requests)) {
    if (result.status === "error") errors.push(result.error)
    else if (result.kind === "theme") themes.set(result.key, result.value)
    else icons.set(result.key, result.value)
  }
  return { themes, icons, errors }
}

async function loadAsset(
  pluginId: string,
  label: string,
  signal: AbortSignal | undefined,
  load: () => Promise<LoadedAssetSuccess>,
): Promise<LoadedAsset> {
  try {
    return await load()
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      status: "error",
      error: {
        pluginId,
        message: `${label} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}
