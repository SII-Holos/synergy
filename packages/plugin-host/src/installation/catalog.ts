import type { PresetPackage } from "@ericsanchezok/synergy-plugin/package"

export const PRESET_IDS = ["core", "full", "web", "desktop"] as const
export const ASSEMBLY_PRESET_IDS = ["workflows", "connections"] as const
export type PresetID = (typeof PRESET_IDS)[number]

export const FULL_COMPONENTS = [
  "acp",
  "code-tools",
  "computer-runtime",
  "external-agents",
  "formatter",
  "library",
  "digital-twin",
  "lsp",
  "mcp",
  "media",
  "note",
  "plugin-kit",
  "presets",
  "server",
  "workbench",
  "agenda",
  "light-loop",
  "blueprint",
  "lattice",
  "boss",
  "anima",
  "channels",
  "channel-feishu",
  "github",
  "channel-github",
  "email",
  "agenda-blueprint",
  "agenda-light-loop",
  "plugin-agenda",
  "plugin-blueprint",
  "plugin-light-loop",
  "boss-feishu",
  "github-agenda",
  "channel-blueprint",
  "channel-light-loop",
  "channel-lattice",
] as const

export function presetPackage(id: PresetID, version: string) {
  const packageName = (name: string) => `@ericsanchezok/synergy-${name}`
  const selections: Record<PresetID, string[]> = {
    core: [],
    full: FULL_COMPONENTS.map(packageName),
    web: [packageName("full"), packageName("web-app")],
    desktop: [packageName("web"), packageName("desktop-app"), packageName("browser-runtime")],
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
  const id = spec === "browser" ? "desktop" : spec === "computer" ? "computer-runtime" : spec
  return ([...PRESET_IDS, ...ASSEMBLY_PRESET_IDS, ...FULL_COMPONENTS] as readonly string[]).includes(id)
    ? `@ericsanchezok/synergy-${id}@${version}`
    : spec
}
