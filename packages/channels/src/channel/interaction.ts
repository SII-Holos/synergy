import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"

export namespace ChannelInteraction {
  export function forType(channelType: string): SessionInteraction.Info {
    return channelType === "feishu"
      ? SessionInteraction.interactive(`channel:${channelType}`)
      : SessionInteraction.unattended(`channel:${channelType}`)
  }
}
