import { SessionDrive } from "../session/drive"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { Log } from "../util/log"
import { AgendaSessionWakeup } from "./session-wakeup"
import { AgendaTypes } from "./types"

export namespace AgendaDelivery {
  const log = Log.create({ service: "agenda.delivery" })

  export interface DeliverInput {
    item: AgendaTypes.Item
    sessionID: string
    deliveryKey: string
    lastMessage: string | undefined
  }

  export async function deliver(input: DeliverInput): Promise<void> {
    if (input.item.deliveryMode === "session_guidance") {
      await deliverSessionGuidance(input)
      return
    }

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

      await SessionInbox.deliverUnique({
        sessionID: session.id,
        deliveryKey: input.deliveryKey,
        mode: "task",
        message: {
          role: "user",
          origin: { type: "agenda", sessionID: input.sessionID },
          metadata: { source: "agenda", sourceSessionID: input.sessionID, agendaItemID: input.item.id },
          ...(instruction ? { tools: instruction.tools } : {}),
          parts: [
            { type: "text", text },
            ...(instruction
              ? [
                  {
                    type: "text" as const,
                    text: instruction.text,
                    origin: "system" as const,
                  },
                ]
              : []),
          ],
        },
      })
      await SessionDrive.request(session.id, "agenda-delivery", { waitForProcessing: true })
    } catch (err) {
      log.error("delivery failed", {
        itemID: input.item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }
  async function deliverSessionGuidance(input: DeliverInput): Promise<void> {
    if (input.item.silent) return
    const target = input.item.origin.sessionID
    if (!target) {
      log.warn("session guidance target missing", { itemID: input.item.id })
      return
    }

    const session = await SessionManager.getSession(target)
    if (!session) {
      log.warn("session guidance target not found", { itemID: input.item.id, sessionID: target })
      return
    }

    await SessionInbox.deliverUnique({
      sessionID: session.id,
      deliveryKey: input.deliveryKey,
      mode: "steer",
      message: {
        role: "user",
        visible: false,
        origin: { type: "agenda", sessionID: input.sessionID },
        metadata: { source: "agenda", sourceSessionID: input.sessionID, agendaItemID: input.item.id },
        parts: [{ type: "text", text: input.item.prompt, origin: "system" }],
      },
    })
    await SessionDrive.request(session.id, "agenda-session-guidance")
  }
}
