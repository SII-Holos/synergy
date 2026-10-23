import { componentFeatures } from "./features"
import { registerToolPolicy } from "./tool-policy"
import { ChannelSetup } from "@ericsanchezok/synergy-channels/channel/setup"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerConnectionsAgents } from "./agents"
import { GithubProvider } from "./channel/provider/github"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { GithubDeliverFixTool } from "./channel/tools/github-deliver-fix"
export function channelGithub(): RuntimeComponent {
  return {
    id: "channel-github",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { channels: version, github: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      ChannelSetup.register({
        id: "github",
        label: "GitHub",
        async configure(...args) {
          const { configure } = await import("./cli/setup")
          return configure(...args)
        },
      })
      registerConfig()
      registerConnectionsAgents()
      registerToolPolicy()
      Channel.registerProvider(new GithubProvider())
      ToolRegistry.registerToolProvider("channel-github", () => [GithubDeliverFixTool])
    },
  }
}
