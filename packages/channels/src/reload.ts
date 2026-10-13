import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Channel } from "./channel"
import { ChannelOutbound } from "./channel/outbound"
export function registerReload() {
  RuntimeReloadContributions.register({
    id: "channels",
    targets: {
      async channel() {
        ChannelOutbound.init({ getProvider: Channel.getProvider })
        await Channel.reload()
      },
    },
  })
}
