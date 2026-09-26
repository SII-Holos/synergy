import { registerReload } from "./reload"
import { PluginMarketplaceRegistry } from "./plugin/marketplace-registry"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerPluginMigrations } from "./plugin/migration"
import { registerInstallationMigrations } from "./installation/migration"
import { Plugin } from "./plugin"
import { registerPluginSkillSource } from "./plugin/skill-source"
import { registerPluginToolContext } from "./plugin/tool-context"
import { registerPluginStartup } from "./plugin/startup"
import { registerPluginSessionHooks } from "./plugin/session-hooks"
import { registerAgentPluginSource } from "./plugin/agent-source"
import { registerPermissionPluginSource } from "./plugin/permission-source"
import { registerProviderPluginAuth } from "./plugin/provider-auth-source"
import { registerToolPluginSource } from "./plugin/tool-source"
import { registerConfig } from "./config-schema"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { peekRuntimeEndpointGeneration } from "@ericsanchezok/synergy-harness/util/runtime-endpoint"

export function plugins(): RuntimeComponent {
  return {
    id: "plugin-host",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      initializeExtensions: () => Plugin.init(),
      async started() {
        const log = Log.create({ service: "plugin-host" })
        await Plugin.runPendingInstallLifecycles().catch((error) =>
          log.warn("pending plugin install lifecycles failed", { error }),
        )
        const endpointGeneration = peekRuntimeEndpointGeneration()
        if (endpointGeneration)
          void Plugin.trigger("runtime.started", { endpointGeneration }, {}).catch((error) =>
            log.warn("plugin runtime.started hooks failed", { error }),
          )
      },
      resident: {
        async start() {
          PluginMarketplaceRegistry.prefetchRegistry()
        },
        async stop() {},
      },
    }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerPluginMigrations()
      registerInstallationMigrations()
      Plugin.registerLifecycle()
      registerPluginSkillSource()
      registerPluginToolContext()
      registerPluginStartup()
      registerPluginSessionHooks()
      registerAgentPluginSource()
      registerPermissionPluginSource()
      registerProviderPluginAuth()
      registerToolPluginSource()
    },
  }
}
