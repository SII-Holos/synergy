import type { CommandModule } from "yargs"

export const builtinCommands: Array<{ command: string | string[]; describe: string; load(): Promise<CommandModule> }> =
  [
    {
      command: "send [message..]",
      describe: "send a message to synergy",
      load: async () => (await import("./cmd/run")).SendCommand as unknown as CommandModule,
    },
    {
      command: "generate",
      describe: "generate the OpenAPI contract",
      load: async () => (await import("./cmd/generate")).GenerateCommand as unknown as CommandModule,
    },
    {
      command: "auth",
      describe: "manage credentials",
      load: async () => (await import("./cmd/auth")).AuthCommand as unknown as CommandModule,
    },
    {
      command: "agent",
      describe: "manage agents",
      load: async () => (await import("./cmd/agent")).AgentCommand as unknown as CommandModule,
    },
    {
      command: "upgrade [target]",
      describe: "upgrade synergy to the latest or a specific version",
      load: async () => (await import("./cmd/upgrade")).UpgradeCommand as unknown as CommandModule,
    },
    {
      command: "uninstall",
      describe: "uninstall synergy and remove all related files",
      load: async () => (await import("./cmd/uninstall")).UninstallCommand as unknown as CommandModule,
    },
    {
      command: "models [provider]",
      describe: "list all available models",
      load: async () => (await import("./cmd/models")).ModelsCommand as unknown as CommandModule,
    },
    {
      command: ["$0", "server"],
      describe: "start synergy server",
      load: async () => (await import("./cmd/server")).ServerCommand as unknown as CommandModule,
    },
    {
      command: "debug",
      describe: "debugging and troubleshooting tools",
      load: async () => (await import("./cmd/debug")).DebugCommand as unknown as CommandModule,
    },
    {
      command: "stats",
      describe: "show token usage and cost statistics",
      load: async () => (await import("./cmd/stats")).StatsCommand as unknown as CommandModule,
    },
    {
      command: "mcp",
      describe: "manage MCP (Model Context Protocol) servers",
      load: async () => (await import("./cmd/mcp")).McpCommand as unknown as CommandModule,
    },
    {
      command: "export [sessionID]",
      describe: "export a session transcript or self-contained rollout ZIP",
      load: async () => (await import("./cmd/export")).ExportCommand as unknown as CommandModule,
    },
    {
      command: "import <file>",
      describe: "import a session transcript or rollout ZIP",
      load: async () => (await import("./cmd/import")).ImportCommand as unknown as CommandModule,
    },
    {
      command: "acp",
      describe: "start ACP (Agent Client Protocol) server",
      load: async () => (await import("./cmd/acp")).AcpCommand as unknown as CommandModule,
    },
    {
      command: "web",
      describe: "open web interface (connects to running server)",
      load: async () => (await import("./cmd/web")).WebCommand as unknown as CommandModule,
    },
    {
      command: "session",
      describe: "manage sessions",
      load: async () => (await import("./cmd/session")).SessionCommand as unknown as CommandModule,
    },
    {
      command: "channel",
      describe: "manage messaging channels",
      load: async () => (await import("./cmd/channel")).ChannelCommand as unknown as CommandModule,
    },
    {
      command: "holos",
      describe: "manage Holos identity and runtime",
      load: async () => (await import("./cmd/holos")).HolosCommand as unknown as CommandModule,
    },
    {
      command: "config",
      describe: "manage synergy configuration",
      load: async () => (await import("./cmd/config")).ConfigCommand as unknown as CommandModule,
    },
    {
      command: "library",
      describe: "manage library memory and learning",
      load: async () => (await import("./cmd/library")).LibraryCommand as unknown as CommandModule,
    },
    {
      command: "embed",
      describe: "manage the local embedding model",
      load: async () => (await import("./cmd/embed")).EmbedCommand as unknown as CommandModule,
    },
    {
      command: "start",
      describe: "start synergy background service",
      load: async () => (await import("./cmd/start")).StartCommand as unknown as CommandModule,
    },
    {
      command: "stop",
      describe: "stop synergy background service",
      load: async () => (await import("./cmd/stop")).StopCommand as unknown as CommandModule,
    },
    {
      command: "status",
      describe: "show synergy background service status",
      load: async () => (await import("./cmd/status")).StatusCommand as unknown as CommandModule,
    },
    {
      command: "logs",
      describe: "show synergy background service logs",
      load: async () => (await import("./cmd/logs")).LogsCommand as unknown as CommandModule,
    },
    {
      command: "doctor",
      describe: "diagnose synergy sandbox and environment",
      load: async () => (await import("./cmd/doctor")).DoctorCommand as unknown as CommandModule,
    },
    {
      command: "diagnostics",
      describe: "create a local diagnostics package",
      load: async () => (await import("./cmd/diagnostics")).DiagnosticsCommand as unknown as CommandModule,
    },
    {
      command: "browser",
      describe: "diagnose and install Chromium for Browser tools",
      load: async () => (await import("./cmd/browser")).BrowserCommand as unknown as CommandModule,
    },
    {
      command: "plugin",
      describe: "install, remove, update, and inspect plugins",
      load: async () => (await import("./cmd/plugin")).PluginCommand as unknown as CommandModule,
    },
    {
      command: "data",
      describe: "manage synergy data location and storage",
      load: async () => (await import("./cmd/data")).DataCommand as unknown as CommandModule,
    },
    {
      command: "migrate",
      describe: "move synergy data to a new location (alias for 'data move')",
      load: async () => (await import("./cmd/data")).MigrateCommand as unknown as CommandModule,
    },
    {
      command: "migration",
      describe: "manage schema and data migrations",
      load: async () => (await import("./cmd/migration")).MigrationCommand as unknown as CommandModule,
    },
  ]
