import webpush from "web-push"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { PushTypes } from "./types"
import { Log } from "../util/log"

export namespace PushStore {
  const log = Log.create({ service: "push.store" })

  export async function list(): Promise<PushTypes.Subscription[]> {
    const ids = await Storage.scan(StoragePath.pushSubscriptionsRoot())
    const records = await Storage.readMany<PushTypes.Subscription>(ids.map((id) => StoragePath.pushSubscription(id)))
    return records.filter((x): x is PushTypes.Subscription => Boolean(x))
  }

  /**
   * Idempotent upsert keyed by endpoint: re-subscribing from the same device
   * refreshes its keys/categories instead of duplicating fan-out targets.
   */
  export async function upsert(input: PushTypes.SubscribeInput): Promise<PushTypes.Subscription> {
    const existing = await findByEndpoint(input.endpoint)
    const record: PushTypes.Subscription = {
      id: existing?.id ?? `push_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      endpoint: input.endpoint,
      keys: input.keys,
      ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
      created: existing?.created ?? Date.now(),
      categories: input.categories ?? existing?.categories ?? PushTypes.DEFAULT_CATEGORIES,
    }
    await Storage.write(StoragePath.pushSubscription(record.id), record)
    return record
  }

  export async function removeByEndpoint(endpoint: string): Promise<void> {
    const existing = await findByEndpoint(endpoint)
    if (!existing) return
    await Storage.remove(StoragePath.pushSubscription(existing.id))
  }

  export async function removeById(id: string): Promise<boolean> {
    const existing = await Storage.read<PushTypes.Subscription>(StoragePath.pushSubscription(id)).catch(() => undefined)
    if (!existing) return false
    await Storage.remove(StoragePath.pushSubscription(id))
    return true
  }

  export async function findByEndpoint(endpoint: string): Promise<PushTypes.Subscription | undefined> {
    const all = await list()
    return all.find((s) => s.endpoint === endpoint)
  }

  export async function updateCategories(id: string, categories: PushTypes.Categories): Promise<void> {
    const existing = await Storage.read<PushTypes.Subscription>(StoragePath.pushSubscription(id)).catch(() => undefined)
    if (!existing) return
    await Storage.write(StoragePath.pushSubscription(id), { ...existing, categories })
  }

  /**
   * VAPID server keys. Generated once on first use and persisted; the private
   * key is a credential — never logged, exported, or returned by any route.
   */
  export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    const existing = await Storage.read<{ publicKey: string; privateKey: string }>(StoragePath.pushVapid()).catch(
      () => undefined,
    )
    if (existing?.publicKey && existing?.privateKey) return existing
    const generated = webpush.generateVAPIDKeys()
    await Storage.write(StoragePath.pushVapid(), generated)
    log.info("generated VAPID key pair")
    return generated
  }
}
