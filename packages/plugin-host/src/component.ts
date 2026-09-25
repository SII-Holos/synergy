import { registerReload } from "./reload"
import { PluginMarketplaceRegistry } from "./plugin/marketplace-registry"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerPluginMigrations } from "./plugin/migration"
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

export function plugins(): RuntimeComponent {
  return {
    id: "plugin-host",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      initializeExtensions: () => Plugin.init(),
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
