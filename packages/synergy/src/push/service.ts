import webpush from "web-push"
import { PushStore } from "./store"
import { PushTypes } from "./types"
import { Log } from "../util/log"

export namespace PushService {
  const log = Log.create({ service: "push.service" })

  type PayloadCategory = PushTypes.Payload["category"]

  const TTL_BY_CATEGORY: Record<PayloadCategory, number> = {
    input: 3600,
    completion: 300,
    error: 300,
    test: 300,
  }

  const URGENCY_BY_CATEGORY: Record<PayloadCategory, "high" | "normal"> = {
    input: "high",
    completion: "normal",
    error: "normal",
    test: "normal",
  }

  export type SendFn = typeof webpush.sendNotification

  let sendFn: SendFn = webpush.sendNotification.bind(webpush)

  /** Test seam: replace the transport without touching the real push services. */
  export function setSender(fn: SendFn) {
    sendFn = fn
  }

  export function resetSender() {
    sendFn = webpush.sendNotification.bind(webpush)
  }

  /**
   * Fan out one payload to every opted-in subscription. Endpoint failures are
   * per-device: 404/410 prunes the stale subscription, every other error is
   * logged and never propagates — a broken device must not block other
   * devices or the event publisher.
   */
  export async function send(payload: PushTypes.Payload): Promise<void> {
    const subscriptions = await PushStore.list()
    const targets = subscriptions.filter((s) => {
      if (payload.category === "test") return true
      return s.categories[payload.category as "completion" | "error" | "input"] === true
    })
    if (targets.length === 0) return

    const vapid = await PushStore.vapidKeys()
    const serialized = JSON.stringify(payload)

    await Promise.allSettled(targets.map((sub) => deliver(sub, serialized, payload.category, vapid)))
  }

  /**
   * Deliver one payload to a single subscription (the settings "test" flow).
   * Rejects on transport failure so the caller can surface why the test did
   * not arrive; 404/410 still prunes the dead subscription before rejecting.
   */
  export async function sendTo(subscription: PushTypes.Subscription, payload: PushTypes.Payload): Promise<void> {
    const vapid = await PushStore.vapidKeys()
    await deliver(subscription, JSON.stringify(payload), payload.category, vapid, { propagate: true })
  }

  async function deliver(
    sub: PushTypes.Subscription,
    serialized: string,
    category: PushTypes.Payload["category"],
    vapid: { publicKey: string; privateKey: string },
    options?: { propagate?: boolean },
  ) {
    try {
      await sendFn({ endpoint: sub.endpoint, keys: sub.keys }, serialized, {
        TTL: TTL_BY_CATEGORY[category],
        urgency: URGENCY_BY_CATEGORY[category],
        vapidDetails: {
          subject: "mailto:synergy@localhost",
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      })
    } catch (error: unknown) {
      const statusCode = (error as { statusCode?: number })?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        await PushStore.removeById(sub.id).catch(() => undefined)
        log.info("pruned expired push subscription", { subscriptionID: sub.id })
      } else {
        log.warn("push delivery failed", { subscriptionID: sub.id, error })
      }
      if (options?.propagate) throw error
    }
  }
}
