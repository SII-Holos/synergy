import { SessionInbox } from "../session/inbox"
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
    const target = input.item.origin.endpoint ?? input.item.origin.sessionID
    if (!target) {
      log.warn("no delivery target — origin endpoint and sessionID both missing, suppressing delivery", {
        itemID: input.item.id,
      })
      return
    }

    try {
      const { SessionManager } = await import("../session/manager")
      const session = await SessionManager.getSession(target)
      if (!session) {
        log.warn("delivery target session not found", {
          itemID: input.item.id,
          target: typeof target === "string" ? target : "endpoint",
        })
        return
      }

      await SessionInbox.deliver({
        sessionID: session.id,
        mode: "task",
        message: {
          role: "user",
          visible: true,
          parts: [{ type: "text", text }],
          origin: { type: "agenda", sessionID: input.sessionID },
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
