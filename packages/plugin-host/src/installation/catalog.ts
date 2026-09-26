import type { PresetPackage } from "@ericsanchezok/synergy-plugin/package"

export const PRESET_IDS = ["core", "full", "web", "desktop"] as const
export type PresetID = (typeof PRESET_IDS)[number]

export const FULL_COMPONENTS = [
  "acp",
  "browser-runtime",
  "code-tools",
  "computer-runtime",
  "connections",
  "external-agents",
  "formatter",
  "library",
  "link-client",
  "lsp",
  "mcp",
  "media",
  "note",
  "plugin-kit",
  "presets",
  "server",
  "workbench",
  "workflows",
] as const

export function presetPackage(id: PresetID, version: string) {
  const packageName = (name: string) => `@ericsanchezok/synergy-${name}`
  const selections: Record<PresetID, string[]> = {
    core: [],
    full: FULL_COMPONENTS.map(packageName),
    web: [packageName("full"), packageName("web-app")],
    desktop: [packageName("web"), packageName("desktop-app")],
  }
  const packages = Object.fromEntries(selections[id].map((name) => [name, version]))
  return {
    name: packageName(id),
    version,
    type: "module" as const,
    license: "MIT",
    dependencies: packages,
    synergy: {
      formatVersion: 1,
      kind: "preset",
      id,
      version,
      compatibility: { synergy: version },
      packages,
    } satisfies PresetPackage,
  }
}

export function resolveBuiltinPackage(spec: string, version: string) {
  const id = spec === "browser" ? "browser-runtime" : spec === "computer" ? "computer-runtime" : spec
  return ([...PRESET_IDS, ...FULL_COMPONENTS] as readonly string[]).includes(id)
    ? `@ericsanchezok/synergy-${id}@${version}`
    : spec
}
