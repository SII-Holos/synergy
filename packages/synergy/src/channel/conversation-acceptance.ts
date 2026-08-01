import { Log } from "../util/log"
import { BusyError } from "../session/error"
import { SessionManager } from "../session/manager"
import { SessionInbox } from "../session/inbox"
import { InvokeInput } from "../session/invoke"
import { ChannelBusyHandoff } from "./busy-handoff"

const log = Log.create({ service: "channel.conversation" })

/**
 * Separates durable acceptance from background execution. Acceptance either
 * reserves the Session lease synchronously or persists the message in the
 * SessionInbox before the provider lane is released.
 */
export namespace ChannelConversationAcceptance {
  export type Acceptance = { accepted: true; execution: Promise<void> } | { accepted: false }

  export async function accept(input: {
    sessionID: string
    deliveryKey: string
    parts?: InvokeInput["parts"]
    prepareParts?: () => Promise<InvokeInput["parts"]>
    metadata: Record<string, unknown>
    model?: { providerID: string; modelID: string }
    variant?: string
    execute: (lease: SessionManager.LoopLease, parts: InvokeInput["parts"]) => Promise<void>
  }): Promise<Acceptance> {
    const prepareParts = input.prepareParts ?? (() => Promise.resolve(input.parts ?? []))
    const existing = await SessionInbox.findDelivery(input.sessionID, input.deliveryKey)
    if (existing) {
      log.info("duplicate conversation delivery already accepted", {
        sessionID: input.sessionID,
        itemID: existing.itemID,
      })
      return { accepted: true, execution: Promise.resolve() }
    }
    const queue = async () => {
      const duplicate = await SessionInbox.findDelivery(input.sessionID, input.deliveryKey)
      if (duplicate) return { status: "duplicate" as const, ...duplicate }
      return ChannelBusyHandoff.deliverBusyTaskToInbox({
        error: new BusyError(input.sessionID),
        sessionID: input.sessionID,
        deliveryKey: input.deliveryKey,
        parts: await prepareParts(),
        metadata: input.metadata,
        model: input.model,
        variant: input.variant,
      })
    }

    const lease = SessionManager.acquire(input.sessionID)
    if (!lease) {
      const queued = await queue()
      if (queued.status === "not-busy") return { accepted: false }
      log.info("busy session message durably queued", {
        sessionID: input.sessionID,
        itemID: queued.status === "queued" ? queued.itemID : undefined,
        duplicate: queued.status === "duplicate",
      })
      if (!SessionManager.isRunning(input.sessionID)) {
        const { SessionDrive } = await import("../session/drive")
        await SessionDrive.request(input.sessionID, "channel-busy-acceptance")
      }
      return { accepted: true, execution: Promise.resolve() }
    }

    if (await SessionInbox.hasRunnableItem(input.sessionID)) {
      try {
        const queued = await queue()
        if (queued.status === "not-busy") return { accepted: false }
        log.info("queued conversation behind existing session work", {
          sessionID: input.sessionID,
          itemID: queued.status === "queued" ? queued.itemID : undefined,
          duplicate: queued.status === "duplicate",
        })
        return { accepted: true, execution: Promise.resolve() }
      } finally {
        await SessionManager.finish(lease)
      }
    }

    let parts: InvokeInput["parts"]
    try {
      parts = await prepareParts()
    } catch (error) {
      await SessionManager.finish(lease)
      throw error
    }
    const execution = Promise.resolve()
      .then(() => input.execute(lease, parts))
      .finally(() => SessionManager.finish(lease))
    void execution.catch((error) => {
      log.error("conversation execution failed", { sessionID: input.sessionID, error })
    })
    return { accepted: true, execution }
  }
}
