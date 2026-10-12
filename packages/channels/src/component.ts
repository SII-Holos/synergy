import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerChannelMigrations } from "./channel/migration"
import { registerManagedProjectGuard } from "./channel/managed-project-ownership"
import { registerChannelTools } from "./channel/tools"
import { registerChannelSessionProjects } from "./channel/session-projects"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Channel } from "./channel"
import { ChannelCommand } from "./channel/command"
import { AppChannel } from "./channel/app"
import { ChannelOutbound } from "./channel/outbound"
import { ResponseCardRuntime } from "./channel/response-card"
import { registerReload } from "./reload"
import { stopStatusPolling } from "./startup-status"
export function channels(): RuntimeComponent {
  return {
    id: "channels",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      disposeExtensions: async () => stopStatusPolling(),
      resident: {
        async start(config) {
          await ResponseCardRuntime.pruneExpired()
          ChannelOutbound.init({ getProvider: Channel.getProvider })
          if (Object.keys(config.channel ?? {}).length) await Channel.init()
        },
        stop: () => Channel.stopAll(),
      },
    }),
    adapters: { http: new URL("./http.ts", import.meta.url), cli: new URL("./cli-adapter.ts", import.meta.url) },
    register() {
      registerConfig()
      registerChannelMigrations()
      registerManagedProjectGuard()
      registerChannelTools()
      registerChannelSessionProjects()
      BusEvent.register(...Object.values(Channel.Event))
      BusEvent.register(...Object.values(ChannelCommand.Event))
      BusEvent.register(...Object.values(AppChannel.Event))
      registerReload()
    },
  }
}
