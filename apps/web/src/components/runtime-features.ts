const requirements: Record<"settings" | "navigation" | "panel", Readonly<Record<string, string>>> = {
  settings: {
    account: "connections",
    github: "connections",
    channels: "connections",
    email: "connections",
    "synergy-link": "link-client",
    voice: "media",
    learning: "library",
    memory: "library",
    experience: "library",
    mcp: "mcp",
    formatter: "formatter",
    lsp: "lsp",
    boss: "workflows",
  },
  navigation: {
    agenda: "workflows",
    kanban: "workflows",
    library: "library",
    performance: "workbench",
  },
  panel: { notes: "note", lattice: "workflows", boss: "workflows", browser: "browser-runtime" },
}

export function runtimeFeatureAvailable(
  surface: keyof typeof requirements,
  id: string,
  hasComponent: (id: string) => boolean,
): boolean {
  const component = requirements[surface][id]
  return !component || hasComponent(component)
}
