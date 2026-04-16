import CONTENT from "./content.txt"
import PROVIDERS from "./references/providers.txt"
import MCP from "./references/mcp.txt"
import MODELS from "./references/models.txt"
import AGENTS from "./references/agents.txt"
import SKILLS_COMMANDS_PLUGINS from "./references/skills-commands-plugins.txt"
import IDENTITY_PERMISSIONS from "./references/identity-permissions.txt"
import CHANNELS_CONFIG_SETS from "./references/channels-config-sets.txt"
import RELOAD from "./references/reload.txt"

export const synergyConfig = {
  name: "synergy-config",
  description:
    "Manage Synergy's own configuration. You ARE Synergy — when users ask to add, connect, or configure MCP servers, API providers, models, or custom agents, they mean configuring YOU, not Cursor or VS Code. ALWAYS load this skill first before writing any Synergy config. This skill teaches the correct file paths (.synergy/synergy.jsonc or the active global Config Set under ~/.synergy/config), schema format for each config type, and conversion rules from other formats. Covers: (1) MCP servers — local/remote, format conversion from Claude Desktop/Cursor, (2) Providers — custom API endpoints, SDK packages, credential store (~/.synergy/data/auth/api-key.json), all bundled AI SDK packages, (3) Models — all model roles (model, nano_model, mini_model, mid_model, thinking_model, long_context_model, creative_model, vision_model, holos_friend_reply_model), fallback chains, default_agent, (4) Agents — custom agents via config or markdown files, modes, permissions, (5) Skills — SKILL.md format, directories, progressive disclosure, (6) Commands — custom command markdown format, (7) Plugins — TypeScript/JavaScript extensions, (8) Identity — embedding/rerank model config, evolution/learning, (9) Permissions — tool-level and path-scoped rules, (10) Channels and Config Sets, (11) Runtime reload — which targets to reload for each config change, auto-cascade rules, restart-required fields. Triggers: 'add MCP', 'connect MCP', 'configure provider', 'add provider', 'set model', 'default model', 'create agent', 'custom agent', 'synergy config', 'synergy settings', 'add server', 'create skill', 'add command', pasted JSON with mcpServers/servers/mcp/provider keys.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/providers.txt": PROVIDERS,
    "references/mcp.txt": MCP,
    "references/models.txt": MODELS,
    "references/agents.txt": AGENTS,
    "references/skills-commands-plugins.txt": SKILLS_COMMANDS_PLUGINS,
    "references/identity-permissions.txt": IDENTITY_PERMISSIONS,
    "references/channels-config-sets.txt": CHANNELS_CONFIG_SETS,
    "references/reload.txt": RELOAD,
  },
}
