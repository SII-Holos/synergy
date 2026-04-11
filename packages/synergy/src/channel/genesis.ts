import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInteraction } from "../session/interaction"
import { Channel } from "."

export namespace GenesisChannel {
  const CHANNEL_TYPE = "genesis"
  const ACCOUNT_ID = "local"
  const CHAT_ID = "setup"

  export function channelInfo(): Channel.Info {
    return {
      type: CHANNEL_TYPE,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
    }
  }

  export function endpoint(): SessionEndpoint.Info {
    return SessionEndpoint.fromChannel(channelInfo())
  }

  export async function session(): Promise<Session.Info> {
    return Session.getOrCreateForEndpoint(endpoint(), undefined, SessionInteraction.unattended("channel:genesis"))
  }

  export async function reset(): Promise<void> {
    await Session.archiveEndpointSession(endpoint())
  }
}
