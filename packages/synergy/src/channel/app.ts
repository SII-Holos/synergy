import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInteraction } from "../session/interaction"
import { Log } from "../util/log"
import { Channel } from "."

export namespace AppChannel {
  const log = Log.create({ service: "channel.app" })

  const CHANNEL_TYPE = "app"
  const ACCOUNT_ID = "local"
  const CHAT_ID = "home"

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
    return Session.getOrCreateForEndpoint(endpoint(), undefined, SessionInteraction.interactive("channel:app"))
  }

  export async function reset(): Promise<void> {
    await Session.archiveEndpointSession(endpoint())
  }

  export const Event = {
    Push: BusEvent.define(
      "app.push",
      z.object({
        type: z.enum(["agenda.result", "notification"]),
        title: z.string().optional(),
        body: z.string().optional(),
        sessionID: z.string().optional(),
        itemID: z.string().optional(),
      }),
    ),
  }

  export async function push(input: {
    type: "agenda.result" | "notification"
    title?: string
    body?: string
    sessionID?: string
    itemID?: string
  }) {
    log.info("push", input)
    Bus.publish(Event.Push, input)
  }
}
