import { Scope } from "../scope"
import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionInteraction } from "../session/interaction"
import { Log } from "../util/log"

export namespace AppChannel {
  const log = Log.create({ service: "channel.app" })

  export async function session(): Promise<Session.Info> {
    return Session.create({
      scope: Scope.home(),
      interaction: SessionInteraction.interactive("channel:app"),
    })
  }

  export async function reset(): Promise<void> {
    return
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
