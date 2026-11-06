const workflows = [
  "agenda",
  "light-loop",
  "blueprint",
  "lattice",
  "boss",
  "anima",
  "agenda-blueprint",
  "agenda-light-loop",
  "plugin-agenda",
  "plugin-blueprint",
  "plugin-light-loop",
] as const

const connections = [
  "channels",
  "channel-feishu",
  "github",
  "channel-github",
  "holos",
  "channel-clarus",
  "email",
  "boss-feishu",
  "github-agenda",
  "channel-blueprint",
  "channel-light-loop",
  "channel-lattice",
] as const

export const legacyComponentSelections: Readonly<Record<string, readonly string[]>> = {
  "@ericsanchezok/synergy-workflows": workflows.map((id) => `@ericsanchezok/synergy-${id}`),
  "@ericsanchezok/synergy-connections": [...connections, ...workflows].map((id) => `@ericsanchezok/synergy-${id}`),
}

export function expandLegacyComponentSelection(roots: readonly string[]) {
  return [...new Set(roots.flatMap((name) => legacyComponentSelections[name] ?? [name]))]
}

export const retiredIdentityPackages = new Set([
  "@ericsanchezok/synergy-holos",
  "@ericsanchezok/synergy-channel-clarus",
])
