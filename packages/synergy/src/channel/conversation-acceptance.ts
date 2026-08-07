import { Log } from "../util/log"
import { SessionManager } from "../session/manager"
import { SessionInbox } from "../session/inbox"
import { InvokeInput } from "../session/invoke"

const log = Log.create({ service: "channel.conversation" })

/**
 * Separates durable acceptance from background execution. Every delivery is
 * persisted before the provider lane is released, then an idle Session lease
 * is reserved for immediate execution when no older work is queued.
 */
export namespace ChannelConversationAcceptance {
  export type Acceptance = { accepted: true; execution: Promise<void> } | { accepted: false }

  export async function accept(input: {
    sessionID: string
    deliveryKey: string
    parts?: InvokeInput["parts"]
    prepareParts?: (messageID: string) => Promise<InvokeInput["parts"]>
    metadata: Record<string, unknown>
    model?: { providerID: string; modelID: string }
    variant?: string
    execute: (
      lease: SessionManager.LoopLease,
      delivery: { itemID: string; messageID: string; parts: InvokeInput["parts"] },
    ) => Promise<void>
  }): Promise<Acceptance> {
    const prepareParts = input.prepareParts ?? (() => Promise.resolve(input.parts ?? []))
    let preparedParts: InvokeInput["parts"] | undefined
    const delivery = await SessionInbox.deliverUniquePrepared({
      sessionID: input.sessionID,
      deliveryKey: input.deliveryKey,
      mode: "task",
      prepareMessage: async (messageID) => {
        preparedParts = await prepareParts(messageID)
        return {
          origin: { type: "channel" as const, label: "Channel" },
          role: "user" as const,
          parts: preparedParts,
          visible: true,
          metadata: input.metadata,
          model: input.model,
          variant: input.variant,
        }
      },
    })
    if (!delivery.created) {
      log.info("duplicate conversation delivery already accepted", {
        sessionID: input.sessionID,
        itemID: delivery.itemID,
      })
      return { accepted: true, execution: Promise.resolve() }
    }

    const lease = SessionManager.acquire(input.sessionID)
    if (!lease) {
      log.info("busy session message durably queued", {
        sessionID: input.sessionID,
        itemID: delivery.itemID,
      })
      return { accepted: true, execution: Promise.resolve() }
    }

    if (await SessionInbox.hasRunnableItem(input.sessionID, { excludeIDs: new Set([delivery.itemID]) })) {
      await SessionManager.finish(lease)
      log.info("queued conversation behind existing session work", {
        sessionID: input.sessionID,
        itemID: delivery.itemID,
      })
      return { accepted: true, execution: Promise.resolve() }
    }

    let completed = false
    const execution = Promise.resolve()
      .then(() =>
        input.execute(lease, {
          itemID: delivery.itemID,
          messageID: delivery.messageID,
          parts: preparedParts!,
        }),
      )
      .then(() => {
        completed = true
      })
      .finally(async () => {
        if (completed) {
          // The current delivery is materialized and committed by execute, so a
          // successful turn normally leaves nothing runnable behind. But a new
          // item can land mid-run (e.g. a cortex completion steer whose drive
          // request was dropped while the session was busy); that item needs
          // the release-time drive, otherwise it stays stranded in the inbox.
          const leftover = await SessionInbox.hasRunnableItem(input.sessionID, {
            excludeIDs: new Set([delivery.itemID]),
          })
          if (leftover) {
            await SessionManager.finish(lease)
            return
          }
          await SessionManager.finish(lease, { requestNextWork: false })
          return
        }
        await SessionManager.finish(lease)
      })
    void execution.catch((error) => {
      log.error("conversation execution failed", { sessionID: input.sessionID, error })
    })
    return { accepted: true, execution }
  }
}
