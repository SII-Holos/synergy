import type { CommandModule } from "yargs"
import type { CommandEntry } from "@ericsanchezok/synergy-cli/cli/commands"

export const productCommands: CommandEntry[] = [
  {
    command: "migrate",
    describe: "move synergy data to a new location (alias for 'data move')",
    load: async () => (await import("./cli/data")).MigrateCommand as unknown as CommandModule,
  },
  {
    command: "generate",
    describe: "generate the OpenAPI contract",
    load: async () => (await import("./cli/generate")).GenerateCommand as unknown as CommandModule,
  },
  {
    command: ["$0", "server"],
    describe: "start synergy server",
    load: async () => (await import("./cli/server")).ServerCommand as unknown as CommandModule,
  },
  {
    command: "debug",
    describe: "debugging and troubleshooting tools",
    load: async () =>
      (await import("@ericsanchezok/synergy-cli/cli/cmd/debug")).createDebugCommand([
        (await import("@ericsanchezok/synergy-agent-integrations/lsp/cli/debug"))
          .LSPCommand as unknown as CommandModule,
      ]) as unknown as CommandModule,
  },
  {
    command: "stats",
    describe: "show token usage and cost statistics",
    load: async () =>
      (await import("@ericsanchezok/synergy-workbench/stats/cli/stats")).StatsCommand as unknown as CommandModule,
  },
  {
    command: "mcp",
    describe: "manage MCP (Model Context Protocol) servers",
    load: async () =>
      (await import("@ericsanchezok/synergy-agent-integrations/mcp/cli/mcp")).McpCommand as unknown as CommandModule,
  },
  {
    command: "acp",
    describe: "start ACP (Agent Client Protocol) server",
    load: async () =>
      (await import("@ericsanchezok/synergy-agent-integrations/acp/cli/acp")).AcpCommand as unknown as CommandModule,
  },
  {
    command: "web",
    describe: "open web interface (connects to running server)",
    load: async () => (await import("./cli/web")).WebCommand as unknown as CommandModule,
  },
  {
    command: "channel",
    describe: "manage messaging channels",
    load: async () =>
      (await import("@ericsanchezok/synergy-connections/channel/cli/channel"))
        .ChannelCommand as unknown as CommandModule,
  },
  {
    command: "holos",
    describe: "manage Holos identity and runtime",
    load: async () =>
      (await import("@ericsanchezok/synergy-connections/holos/cli/holos")).HolosCommand as unknown as CommandModule,
  },
  {
    command: "library",
    describe: "manage library memory and learning",
    load: async () =>
      (await import("@ericsanchezok/synergy-library/cli/library")).LibraryCommand as unknown as CommandModule,
  },
  {
    command: "embed",
    describe: "manage the local embedding model",
    load: async () =>
      (await import("@ericsanchezok/synergy-library/cli/embed")).EmbedCommand as unknown as CommandModule,
  },
  {
    command: "start",
    describe: "start synergy background service",
    load: async () =>
      (await import("@ericsanchezok/synergy-cli/cli/cmd/start")).StartCommand as unknown as CommandModule,
  },
  {
    command: "stop",
    describe: "stop synergy background service",
    load: async () => (await import("@ericsanchezok/synergy-cli/cli/cmd/stop")).StopCommand as unknown as CommandModule,
  },
  {
    command: "status",
    describe: "show synergy background service status",
    load: async () =>
      (await import("@ericsanchezok/synergy-cli/cli/cmd/status")).StatusCommand as unknown as CommandModule,
  },
  {
    command: "logs",
    describe: "show synergy background service logs",
    load: async () => (await import("@ericsanchezok/synergy-cli/cli/cmd/logs")).LogsCommand as unknown as CommandModule,
  },
  {
    command: "browser",
    describe: "diagnose and install Chromium for Browser tools",
    load: async () =>
      (await import("@ericsanchezok/synergy-browser-runtime/cli/browser")).BrowserCommand as unknown as CommandModule,
  },
  {
    command: "plugin",
    describe: "install, remove, update, and inspect plugins",
    load: async () =>
      (await import("@ericsanchezok/synergy-plugin-host/plugin/cli/plugin")).PluginCommand as unknown as CommandModule,
  },
]
