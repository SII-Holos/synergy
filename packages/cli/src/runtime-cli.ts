import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { createLocalHost, type LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { registerRuntimeWorkers } from "@ericsanchezok/synergy-agent-runtime/workers"
import { loadHttpAdapters } from "@ericsanchezok/synergy-agent-runtime/adapters"
import { loadCliAdapters } from "./cli/components"
import { runtimeCommands } from "./cli/runtime-commands"
import type { CliOptions } from "./main"

export async function createRuntimeCli(components: readonly RuntimeComponent[] = []): Promise<CliOptions> {
  const selected = RuntimeComponents.resolve([localRuntime({ workers: false }), plugins(), ...components])
  const composition = RuntimeComponents.compose(selected)
  const http = selected.some((component) => component.hosts?.includes("http"))
  const routes = http ? await loadHttpAdapters(selected) : []
  const open = async (options: LocalRuntimeOptions, listen: boolean) => {
    const host = options.host ?? createLocalHost()
    return openAgentRuntime({ ...options, host, home: host.root, components, listen })
  }
  const openHttp = async (options: LocalRuntimeOptions) => {
    const handle = await open(options, true)
    if (!handle.server) {
      await handle.close()
      throw new Error("This command requires the server component; run synergy install server")
    }
    return Object.assign(handle, { server: handle.server })
  }
  const adapters = await loadCliAdapters(selected, { openHttp })
  return {
    runtimeFactory: (options) => open(options, false),
    defaultCommand: http ? "server" : undefined,
    register() {
      composition.register()
      for (const route of routes) route.registerHttp()
      ConfigExtensions.completeRegistration()
      registerRuntimeWorkers(selected)
    },
    commands: [
      ...runtimeCommands({ adapters, openHttp, http, web: selected.some((component) => component.id === "web-app") }),
      ...adapters.commands,
    ],
    dataCommands: adapters.dataCommands,
    pluginCommands: async (directory) => {
      const { installedPluginCliMetadata } = await import("@ericsanchezok/synergy-plugin-host/plugin/cli-metadata")
      const { createPluginCliCommandModule } = await import("@ericsanchezok/synergy-plugin-host/plugin/cli-command")
      return (await installedPluginCliMetadata()).map((plugin) =>
        createPluginCliCommandModule({
          plugin,
          resolveScope: async () =>
            (await (await import("@ericsanchezok/synergy-harness/scope")).Scope.fromDirectory(directory)).scope,
        }),
      )
    },
  }
}
