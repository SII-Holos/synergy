import CONTENT from "./content.txt"
import PROVIDERS from "./references/providers.txt"
import MCP from "./references/mcp.txt"
import MODELS from "./references/models.txt"
import AGENTS from "./references/agents.txt"
import SKILLS_COMMANDS_PLUGINS from "./references/skills-commands-plugins.txt"
import LIBRARY_PERMISSIONS from "./references/library-permissions.txt"
import CHANNELS from "./references/channels.txt"
import RELOAD from "./references/reload.txt"

export const synergyConfig = {
  name: "synergy-config",
  description:
    "Manage Synergy configuration for MCP servers, providers, models, agents, Skills, commands, plugins, Library, permissions, Channels, Holos, and runtime reload. Use this before changing Synergy settings or converting configuration from another tool; it documents the canonical domain files, schemas, credentials boundaries, model roles, and reload behavior.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/providers.txt": PROVIDERS,
    "references/mcp.txt": MCP,
    "references/models.txt": MODELS,
    "references/agents.txt": AGENTS,
    "references/skills-commands-plugins.txt": SKILLS_COMMANDS_PLUGINS,
    "references/library-permissions.txt": LIBRARY_PERMISSIONS,
    "references/channels.txt": CHANNELS,
    "references/reload.txt": RELOAD,
  },
}
