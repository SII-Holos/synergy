const requirements: Record<
  "settings" | "navigation" | "panel" | "workflow" | "action",
  Readonly<Record<string, string>>
> = {
  settings: {
    browser: "browser",
    account: "holos",
    github: "github",
    channels: "channels",
    email: "email",
    voice: "media",
    learning: "library",
    memory: "library",
    experience: "library",
    mcp: "mcp",
    formatter: "formatter",
    lsp: "lsp",
    "code-checks": "lsp",
    observability: "workbench",
    boss: "boss",
    worktrees: "workbench",
  },
  navigation: {
    agenda: "agenda",
    kanban: "workbench",
    library: "library",
    performance: "workbench",
    plugins: "plugin-host",
  },
  panel: {
    context: "workbench",
    trajectory: "workbench",
    notes: "note",
    lattice: "lattice",
    boss: "boss",
    browser: "browser",
    "session-review": "workbench",
  },
  workflow: { plan: "blueprint", blueprint: "blueprint", lightloop: "light-loop", lattice: "lattice", boss: "boss" },
  action: { "project.create": "workbench" },
}

export function runtimeFeatureAvailable(
  surface: keyof typeof requirements,
  id: string,
  hasFeature: (id: string) => boolean,
): boolean {
  const feature = requirements[surface][id]
  return !feature || hasFeature(feature)
}
