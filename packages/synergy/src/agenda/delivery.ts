import { Identifier } from "../id/id"
import { SessionManager } from "../session/manager"
import { Log } from "../util/log"
import { AgendaSessionWakeup } from "./session-wakeup"
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
      const session = await SessionManager.getSession(target)
      if (!session) {
        log.warn("delivery target session not found", {
          itemID: input.item.id,
          target: typeof target === "string" ? target : "endpoint",
        })
        return
      }
      const instruction = await AgendaSessionWakeup.loopInstruction({ session, item: input.item }).catch((error) => {
        log.warn("failed to build loop-aware Agenda instruction", {
          itemID: input.item.id,
          sessionID: session.id,
          error,
        })
        return undefined
      })

      await SessionManager.deliver({
        target: session.id,
        mail: {
          type: "user",
          metadata: { source: "agenda", sourceSessionID: input.sessionID, agendaItemID: input.item.id },
          ...(instruction ? { tools: instruction.tools } : {}),
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: Identifier.ascending("message"),
              type: "text",
              text,
            },
            ...(instruction
              ? [
                  {
                    id: Identifier.ascending("part"),
                    sessionID: session.id,
                    messageID: Identifier.ascending("message"),
                    type: "text" as const,
                    text: instruction.text,
                    origin: "system" as const,
                  },
                ]
              : []),
          ],
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
