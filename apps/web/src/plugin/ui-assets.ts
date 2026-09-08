import { parseSkin } from "@ericsanchezok/synergy-plugin/skin"
import type { SkinEntry } from "./registries/skin-registry"
import { pluginAssetIntegrity } from "./asset-integrity"
import { parseTheme, type PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"
import type { PluginContribution } from "./api"
import { resolvePluginAssetUrl } from "./asset-url"
import type { IconEntry } from "./registries/icon-registry"
import { pluginSurfaceId } from "./surface-id"
import { CURRENT_UI_API_VERSION, isCompatibleUIVersion } from "./loaders"

export type LoadedPluginIcon = IconEntry & { pluginId: string }

export interface PluginUIAssetError {
  pluginId: string
  message: string
}

export interface PluginUIAssets {
  skins: Map<string, Omit<SkinEntry, "slot">>
  themes: Map<string, PluginThemeDefinition>
  icons: Map<string, LoadedPluginIcon>
  stylesheets: Map<string, string[]>
  errors: PluginUIAssetError[]
}

export function resolvePluginIconReference(contribution: PluginContribution, iconName: string | undefined) {
  if (!iconName) return iconName
  const declared = contribution.contributions.some((item) => item.kind === "ui.icon" && item.id === iconName)
  return declared ? pluginSurfaceId(contribution.pluginId, iconName) : iconName
}

interface PluginUIAssetLoadOptions {
  serverUrl: string
  signal?: AbortSignal
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
}

type LoadedAssetSuccess =
  | { status: "loaded"; kind: "skin"; key: string; value: Omit<SkinEntry, "slot"> }
  | { status: "loaded"; kind: "theme"; key: string; value: PluginThemeDefinition }
  | { status: "loaded"; kind: "icon"; key: string; value: LoadedPluginIcon }
  | { status: "loaded"; kind: "stylesheet"; key: string; value: string }
type LoadedAsset = LoadedAssetSuccess | { status: "skipped" } | { status: "error"; error: PluginUIAssetError }

export function injectPluginStylesheet(href: string, sha256: string): () => void {
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = href
  link.integrity = pluginAssetIntegrity(sha256)
  link.crossOrigin = "anonymous"
  document.head.appendChild(link)
  return () => link.remove()
}

export async function loadPluginUIAssets(
  contributions: PluginContribution[],
  options: PluginUIAssetLoadOptions,
): Promise<PluginUIAssets> {
  const fetcher = options.fetcher ?? fetch
  const requests: Array<Promise<LoadedAsset>> = []

  for (const contribution of contributions) {
    for (const definition of contribution.contributions) {
      if (definition.kind === "ui.theme") {
        requests.push(
          loadAsset(contribution.pluginId, `Theme "${definition.id}"`, options.signal, async () => {
            const url = resolvePluginAssetUrl(
              options.serverUrl,
              contribution.pluginId,
              contribution.generation,
              definition.path,
            )
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

      if (definition.kind === "ui.skin") {
        requests.push(
          loadAsset(contribution.pluginId, `Skin "${definition.id}"`, options.signal, async () => {
            const assetURL = (file: string) =>
              resolvePluginAssetUrl(options.serverUrl, contribution.pluginId, contribution.generation, file)
            const response = await fetcher(assetURL(definition.path), {
              signal: options.signal,
              integrity: pluginAssetIntegrity(definition.sha256),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const skin = parseSkin(await response.json())
            if (skin.id !== definition.id)
              throw new Error(`Skin ${skin.id} does not match contribution ${definition.id}`)
            const assets = Object.fromEntries(
              await Promise.all(
                Object.entries(skin.assets).map(async ([id, asset]) => {
                  const url = assetURL(asset.path)
                  const resource = definition.assets.find((resource) => resource.entry === asset.path)
                  if (!resource) throw new Error(`Undeclared Skin asset ${asset.path}`)
                  const response = await fetcher(url, {
                    signal: options.signal,
                    integrity: pluginAssetIntegrity(resource.sha256),
                  })
                  if (!response.ok) throw new Error(`Skin asset ${id}: HTTP ${response.status}`)
                  await response.arrayBuffer()
                  return [id, url]
                }),
              ),
            )
            const key = pluginSurfaceId(contribution.pluginId, definition.id)
            return {
              status: "loaded",
              kind: "skin",
              key,
              value: {
                id: key,
                pluginId: contribution.pluginId,
                label: definition.label,
                order: 1000,
                definition: skin,
                assets,
              },
            }
          }),
        )
      }

      if (definition.kind === "ui.icon") {
        requests.push(
          loadAsset(contribution.pluginId, `Icon "${definition.id}"`, options.signal, async () => {
            const url = resolvePluginAssetUrl(
              options.serverUrl,
              contribution.pluginId,
              contribution.generation,
              definition.path,
            )
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

    if (!isCompatibleUIVersion(contribution.uiArtifact?.apiVersion ?? "4.0", CURRENT_UI_API_VERSION)) continue
    for (const resource of contribution.uiArtifact?.resources ?? []) {
      if (resource.kind !== "stylesheet") continue
      const stylesheet = resource.entry
      requests.push(
        loadAsset(contribution.pluginId, "UI stylesheet", options.signal, async () => {
          const url = resolvePluginAssetUrl(
            options.serverUrl,
            contribution.pluginId,
            contribution.generation,
            stylesheet,
          )
          const response = await fetcher(url, {
            signal: options.signal,
            integrity: pluginAssetIntegrity(resource.sha256),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return {
            status: "loaded" as const,
            kind: "stylesheet" as const,
            key: contribution.pluginId,
            value: stylesheet,
          }
        }),
      )
    }
  }

  const skins = new Map<string, Omit<SkinEntry, "slot">>()
  const themes = new Map<string, PluginThemeDefinition>()
  const icons = new Map<string, LoadedPluginIcon>()
  const stylesheets = new Map<string, string[]>()
  const errors: PluginUIAssetError[] = []
  for (const result of await Promise.all(requests)) {
    if (result.status === "error") errors.push(result.error)
    else if (result.status === "loaded") {
      if (result.kind === "skin") skins.set(result.key, result.value)
      else if (result.kind === "theme") themes.set(result.key, result.value)
      else if (result.kind === "icon") icons.set(result.key, result.value)
      else stylesheets.set(result.key, [...(stylesheets.get(result.key) ?? []), result.value])
    }
  }
  return { themes, skins, icons, stylesheets, errors }
}

async function loadAsset(
  pluginId: string,
  label: string,
  signal: AbortSignal | undefined,
  load: () => Promise<LoadedAssetSuccess | { status: "skipped" }>,
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
