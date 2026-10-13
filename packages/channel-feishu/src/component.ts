import { ChannelSetup } from "@ericsanchezok/synergy-channels/channel/setup"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { FeishuProvider } from "./channel/provider/feishu"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
export function channelFeishu(): RuntimeComponent {
  return {
    id: "channel-feishu",
    apiVersion: 1,
    version,
    requires: { channels: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      ChannelSetup.register({
        id: "feishu",
        label: "Feishu / Lark",
        async configure(...args) {
          const { configure } = await import("./cli/setup")
          return configure(...args)
        },
      })
      registerConfig()
      Channel.registerProvider(new FeishuProvider())
    },
  }
}
