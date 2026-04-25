import { SessionManager } from "../session/manager"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { AgendaTypes } from "./types"

export namespace AgendaDelivery {
  const log = Log.create({ service: "agenda.delivery" })

  export interface DeliverInput {
    item: AgendaTypes.Item
    sessionID: string
    lastMessage: string | undefined
  }

  export async function deliver(input: DeliverInput): Promise<void> {
    if (input.item.silent) return

    const text = input.lastMessage ?? `Agenda task "${input.item.title}" completed.`
    const target = input.item.origin.endpoint
    if (!target) {
      log.info("no delivery target — origin endpoint missing, suppressing delivery", { itemID: input.item.id })
      return
    }
    const type = input.item.wake !== false ? "user" : "assistant"

    try {
      const session = await SessionManager.getSession(target)
      if (!session) return

      await SessionManager.deliver({
        target: session.id,
        mail: {
          type,
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
}
