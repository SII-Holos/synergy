import { registerReload } from "./reload"
import { ChannelOutbound } from "./channel/outbound"
import { registerProviders } from "./channel/provider"
import { ResponseCardRuntime } from "./channel/response-card"
import { Channel } from "./channel"
import { HolosRuntime } from "./holos/runtime"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerHolosMigrations } from "./holos/migration"
import { registerChannelMigrations } from "./channel/migration"
import { registerHolosRuntime } from "./holos/runtime"
import { registerManagedProjectGuard } from "./channel/managed-project-ownership"
import { registerConnectionsAgents } from "./agents"
import { registerEmailTools } from "./email/tools"
import { registerChannelTools } from "./channel/tools"
import { registerChannelSessionProjects } from "./channel/session-projects"
import { GithubWatchPolicy } from "@ericsanchezok/synergy-workflows/agenda/github-watch-policy"
import { BossRuntime } from "@ericsanchezok/synergy-workflows/boss/boss-runtime"
import { readGithubWatchPolicy, readBossAccounts } from "./workflow-settings"
import { registerConfig } from "./config-schema"

export function connections(): RuntimeComponent {
  return {
    id: "connections",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, workflows: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      resident: {
        async start(config) {
          await ResponseCardRuntime.pruneExpired().catch((error) => {
            Log.create({ service: "connections" }).warn("response-card expired registration cleanup failed", { error })
          })
          registerProviders()
          ChannelOutbound.init({ getProvider: Channel.getProvider })
          if (Object.keys(config.channel ?? {}).length) await Channel.init()
          await HolosRuntime.init()
        },
        async stop() {
          await Channel.stopAll()
        },
      },
    }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerHolosMigrations()
      registerChannelMigrations()
      registerHolosRuntime()
      registerManagedProjectGuard()
      registerConnectionsAgents()
      registerEmailTools()
      registerChannelTools()
      registerChannelSessionProjects()
      GithubWatchPolicy.register(readGithubWatchPolicy)
      BossRuntime.registerAccountSource(readBossAccounts)
    },
  }
}
