import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Channel } from "./channel"
export function registerReload() {
  RuntimeReloadContributions.register({
    id: "channels",
    targets: {
      async channel() {
        await Channel.reload()
      },
    },
  })
}
