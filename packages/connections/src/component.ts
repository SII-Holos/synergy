import { channels } from "@ericsanchezok/synergy-channels/component"
import { channelFeishu } from "@ericsanchezok/synergy-channel-feishu/component"
import { github } from "@ericsanchezok/synergy-github/component"
import { channelGithub } from "@ericsanchezok/synergy-channel-github/component"
import { holos } from "@ericsanchezok/synergy-holos/component"
import { channelClarus } from "@ericsanchezok/synergy-channel-clarus/component"
import { email } from "@ericsanchezok/synergy-email/component"
export function connectionComponents() {
  return [channels(), channelFeishu(), github(), channelGithub(), holos(), channelClarus(), email()]
}
