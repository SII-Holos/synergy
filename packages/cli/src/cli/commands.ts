import type { CommandModule } from "yargs"
import type { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"

export interface CommandEntry {
  command: string | string[]
  describe: string
  load(): Promise<CommandModule>
}

export function coreCommands(
  runtimeFactory: typeof openLocalRuntime,
  dataCommands?: () => Promise<CommandModule[]>,
): CommandEntry[] {
  return [
    {
      command: "send [message..]",
      describe: "send a message to synergy",
      load: async () => (await import("./cmd/run")).createSendCommand(runtimeFactory) as unknown as CommandModule,
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
      command: "session",
      describe: "manage sessions",
      load: async () => (await import("./cmd/session")).SessionCommand as unknown as CommandModule,
    },
    {
      command: "config",
      describe: "manage synergy configuration",
      load: async () => (await import("./cmd/config")).ConfigCommand as unknown as CommandModule,
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
      command: "data",
      describe: "manage synergy data location and storage",
      load: async () =>
        (await import("./cmd/data")).createDataCommand((await dataCommands?.()) ?? []) as unknown as CommandModule,
    },
    {
      command: "migration",
      describe: "manage schema and data migrations",
      load: async () => (await import("./cmd/migration")).MigrationCommand as unknown as CommandModule,
    },
  ]
}
