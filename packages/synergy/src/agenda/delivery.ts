import { SessionManager } from "../session/manager"
import { Identifier } from "../id/id"
import { AppChannel } from "../channel/app"
import { Log } from "../util/log"
import { AgendaTypes } from "./types"
import type { SessionEndpoint } from "../session/endpoint"

export namespace AgendaDelivery {
  const log = Log.create({ service: "agenda.delivery" })

  export interface DeliverInput {
    item: AgendaTypes.Item
    sessionID: string
    lastMessage: string | undefined
  }

  export async function deliver(input: DeliverInput): Promise<void> {
    const delivery: AgendaTypes.Delivery = input.item.delivery ?? { target: "auto" }

    if (delivery.target === "silent") return

    const text = input.lastMessage ?? `Agenda task "${input.item.title}" completed.`
    const target = resolveTarget(delivery, input.item.origin)

    try {
      const session = await SessionManager.getSession(target)
      if (!session) return

      await SessionManager.deliver({
        target: session.id,
        mail: {
          type: "assistant",
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: "",
              type: "text",
              text,
            },
          ],
          metadata: {
            mailbox: true,
            sourceSessionID: input.sessionID,
            sourceName: input.item.title,
          },
        },
      })
    } catch (err) {
      log.error("delivery failed", {
        itemID: input.item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }

  function resolveTarget(delivery: AgendaTypes.Delivery, origin: AgendaTypes.Origin): string | SessionEndpoint.Info {
    switch (delivery.target) {
      case "session":
        return delivery.sessionID
      case "home":
        return AppChannel.endpoint()
      case "auto":
        return origin.endpoint ?? AppChannel.endpoint()
      default:
        return AppChannel.endpoint()
    }
  }
}
