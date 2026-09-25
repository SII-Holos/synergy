import type { CommandModule } from "yargs"
import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { loadCliAdapters, CliAdapterContext } from "./components"

export function runtimeCommands(
  input: CliAdapterContext & {
    http: boolean
    web: boolean
    adapters: Awaited<ReturnType<typeof loadCliAdapters>>
  },
): CommandEntry[] {
  return [
    {
      command: "debug",
      storage: "maintenance",
      describe: "debugging and troubleshooting tools",
      load: async () =>
        (await import("./cmd/debug")).createDebugCommand(
          await input.adapters.debugCommands(),
        ) as unknown as CommandModule,
    },
    {
      command: "plugin",
      storage: "maintenance",
      describe: "install, remove, update, and inspect plugins",
      load: async () =>
        (await import("@ericsanchezok/synergy-plugin-host/plugin/cli/plugin")).createPluginCommand(
          await input.adapters.pluginCommands(),
        ) as unknown as CommandModule,
    },
    ...(input.http
      ? [
          {
            command: ["$0", "server"],
            describe: "start synergy server",
            load: async () =>
              (await import("./server")).createServerCommand(async (options) => {
                const { run } = await import("../server/runtime")
                const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
                const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
                const { StartupReporter } = await import("./startup-reporter")
                return run({
                  ...options,
                  runtimeFactory: input.openHttp,
                  status: (printUpdates) =>
                    ScopeContext.provide({
                      scope: Scope.home(),
                      fn: async () => [
                        await (await import("@ericsanchezok/synergy-plugin-host/startup-status")).pluginStatus(),
                        ...(await input.adapters.status(printUpdates, (statuses) =>
                          StartupReporter.print({ title: "Synergy connection update", statuses }),
                        )),
                      ],
                    }),
                })
              }) as unknown as CommandModule,
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
        ]
      : []),
    ...(input.web
      ? [
          {
            command: "web",
            describe: "open web interface (connects to running server)",
            load: async () => (await import("./web")).WebCommand as unknown as CommandModule,
          },
        ]
      : []),
  ]
}
