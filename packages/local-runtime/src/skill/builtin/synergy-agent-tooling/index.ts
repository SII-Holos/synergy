import CONTENT from "./content.txt"
import TOOL_DESIGN from "./references/tool-design.txt"
import MCP_BUILDER from "./references/mcp-builder.txt"
import CLI_CREATOR from "./references/cli-creator.txt"

export const synergyAgentTooling = {
  name: "synergy-agent-tooling",
  description:
    "Design, evaluate, or improve the tooling an agent works with: agent-facing tool contracts (names, descriptions, parameters, error recovery), MCP servers, and agent-friendly CLIs. Use when creating or reviewing tools, MCP servers, or CLI surfaces for agents; route Synergy MCP connection config to synergy-config, and follow the repository add-tool workflow for first-party Synergy product tools.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/tool-design.txt": TOOL_DESIGN,
    "references/mcp-builder.txt": MCP_BUILDER,
    "references/cli-creator.txt": CLI_CREATOR,
  },
}
