import { ChannelSetup } from "@ericsanchezok/synergy-channels/channel/setup"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerReactionOnlyToolPolicy } from "./tool-policy"
import { FeishuProvider } from "./channel/provider/feishu"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ChannelReactionOnlyTool } from "./channel/tools/channel-reaction-only"
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
      registerReactionOnlyToolPolicy()
      Channel.registerProvider(new FeishuProvider())
      ToolRegistry.registerToolProvider("channel-feishu", () => [ChannelReactionOnlyTool])
    },
  }
}
