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
    "Manage Synergy's own configuration. You ARE Synergy — when users ask to add, connect, or configure MCP servers, API providers, models, or custom agents, they mean configuring YOU, not Cursor, VS Code, or Claude Desktop. ALWAYS load this skill first before writing any Synergy config. This skill teaches the canonical domain config layout under ~/.synergy/config/synergy.d and <project>/.synergy/synergy.d, schema format for each config type, and conversion rules from other formats. Covers: (1) MCP servers — local/remote, format conversion from Claude Desktop/Cursor, (2) Providers — custom API endpoints, SDK packages, credential store (~/.synergy/data/auth/api-key.json), all bundled AI SDK packages, (3) Models — all model roles (model, nano_model, mini_model, mid_model, thinking_model, long_context_model, creative_model, vision_model), fallback chains, default_agent, (4) Agents — custom agents via config or markdown files, project instruction files, modes, permissions, (5) Skills — SKILL.md format, directories, progressive disclosure, (6) Commands — custom command markdown format, (7) Plugins — TypeScript/JavaScript extensions, (8) Library — memory and experience settings, with shared embedding/rerank model config in General, (9) Permissions — tool-level and path-scoped rules, (10) Channels, (11) Runtime reload — which targets to reload for each config change, auto-cascade rules, restart-required fields. Triggers: 'add MCP', 'connect MCP', 'configure provider', 'add provider', 'set model', 'default model', 'create agent', 'custom agent', 'project instructions', 'AGENTS.md', 'synergy config', 'synergy settings', 'add server', 'create skill', 'add command', pasted JSON with mcpServers/servers/mcp/provider keys.",
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
