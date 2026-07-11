import type {
  RegistryPermissionItem,
  RegistryPluginSummary,
  RegistryPluginVersion,
} from "@ericsanchezok/synergy-sdk/client"
import type { InstalledPlugin, PluginDetail } from "./types"

type RuntimeMode = RegistryPluginSummary["runtimeMode"]

export type MarketplaceSummary = Omit<RegistryPluginSummary, "source"> & {
  catalogSource?: RegistryPluginSummary["source"]
  repo?: string
  homepage?: string
  downloads?: number
}

export function registryPluginSummary(summary: RegistryPluginSummary): MarketplaceSummary {
  const { source, ...rest } = summary
  return { ...rest, catalogSource: source }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function arrayField(record: Record<string, unknown> | null | undefined, key: string): unknown[] {
  const value = record?.[key]
  return Array.isArray(value) ? value : []
}

function runtimeModeFromManifest(manifest: Record<string, unknown> | null | undefined): RuntimeMode {
  return "process"
}

function toolsFromManifest(manifest: Record<string, unknown> | null | undefined): string[] {
  return arrayField(manifest, "contributions")
    .filter((item) => stringField(asRecord(item), "kind") === "tool")
    .map((tool) => stringField(asRecord(tool), "id"))
    .filter((name): name is string => Boolean(name))
}

function uiSurfacesFromManifest(manifest: Record<string, unknown> | null | undefined): string[] {
  return [
    ...new Set(
      arrayField(manifest, "contributions")
        .map((item) => stringField(asRecord(item), "kind"))
        .filter((kind): kind is string => Boolean(kind?.startsWith("ui."))),
    ),
  ]
}

export function fallbackPluginSummary(input: {
  installed?: InstalledPlugin | null
  detail?: PluginDetail | null
}): MarketplaceSummary | null {
  if (!input.installed) return null
  const manifest = asRecord(input.detail?.manifest)
  const name = input.detail?.name ?? input.installed.name ?? stringField(manifest, "name") ?? input.installed.id
  return {
    id: input.installed.id,
    name,
    description: stringField(manifest, "description") ?? "Installed plugin",
    repo: stringField(manifest, "repository"),
    homepage: stringField(manifest, "homepage"),
    author: { name: stringField(manifest, "author") ?? "Installed locally" },
    verified: false,
    official: false,
    keywords: ["plugin"],
    latestVersion: input.installed.version,
    updatedAt: Date.now(),
    risk: input.detail?.risk ?? input.installed.risk,
    trustTier: input.detail?.trust ?? input.installed.trust,
    runtimeMode: runtimeModeFromManifest(manifest),
    uiSurfaces: uiSurfacesFromManifest(manifest),
    tools: toolsFromManifest(manifest),
    downloads: 0,
  }
}

export function toTimestamp(value: number | string | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Date.now()
  }
  return Date.now()
}

export function collectAllPermissions(versions: RegistryPluginVersion[]): RegistryPermissionItem[] {
  const seen = new Set<string>()
  const all: RegistryPermissionItem[] = []
  for (const version of versions) {
    for (const permission of version.permissionsSummary ?? []) {
      if (seen.has(permission.key)) continue
      seen.add(permission.key)
      all.push(permission)
    }
  }
  return all
}

export function isRegistryPluginNotFoundError(input: unknown, id: string): boolean {
  const message =
    typeof input === "string" ? input : input instanceof Error ? input.message : stringField(asRecord(input), "message")
  return message === `Registry plugin not found: ${id}`
}
