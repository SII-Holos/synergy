import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import path from "node:path"
import webpush from "web-push"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { PushTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace PushStore {
  const log = Log.create({ service: "push.store" })

  // Subscription endpoints + p256dh/auth and the VAPID private key are
  // credential material: together they allow authenticated, encrypted pushes
  // to registered devices. Persist them owner-only, like the provider auth
  // stores (api-key.ts writes its store through a 0600 handle).
  function credentialFile(key: string[]): string {
    return path.join(Global.Path.data, ...key) + ".json"
  }

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
    return Storage.transaction(async () => {
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
    })
  }

  export async function removeByEndpoint(endpoint: string): Promise<void> {
    await Storage.transaction(async () => {
      const existing = await findByEndpoint(endpoint)
      if (existing) await Storage.remove(StoragePath.pushSubscription(existing.id))
    })
  }

  export async function removeById(id: string): Promise<boolean> {
    return Storage.transaction(async () => {
      const [existing] = await Storage.readMany<PushTypes.Subscription>([StoragePath.pushSubscription(id)])
      if (!existing) return false
      await Storage.remove(StoragePath.pushSubscription(id))
      return true
    })
  }

  export async function findByEndpoint(endpoint: string): Promise<PushTypes.Subscription | undefined> {
    const all = await list()
    return all.find((s) => s.endpoint === endpoint)
  }

  export async function updateCategories(id: string, categories: PushTypes.Categories): Promise<void> {
    await Storage.transaction(async () => {
      const [existing] = await Storage.readMany<PushTypes.Subscription>([StoragePath.pushSubscription(id)])
      if (existing) await Storage.write(StoragePath.pushSubscription(id), { ...existing, categories })
    })
  }

  // Memoized first-use generation keyed by the data home: two concurrent
  // callers must observe the same key pair (otherwise one subscribes with a
  // public key the persisted private key no longer backs), and a different
  // home (isolated test fixture) must not inherit another home's keys.
  const runtimeState = RuntimeContext.state(() => ({
    vapidInitHome: undefined as string | undefined,
    vapidInit: undefined as Promise<{ publicKey: string; privateKey: string }> | undefined,
  }))

  /**
   * VAPID server keys. Generated once on first use and persisted owner-only;
   * the private key is a credential — never logged, exported, or returned by
   * any route.
   */
  export function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    const instanceState = runtimeState()

    const home = Global.Path.data
    if (instanceState.vapidInit && instanceState.vapidInitHome === home) return instanceState.vapidInit
    instanceState.vapidInitHome = home
    instanceState.vapidInit = (async () => {
      const filename = credentialFile(StoragePath.pushVapid())
      const existing = await Bun.file(filename)
        .json()
        .catch((error) => {
          if (error?.code === "ENOENT") return
          throw error
        })
      if (existing !== undefined)
        return z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).parse(existing)
      const generated = webpush.generateVAPIDKeys()
      await Storage.writeJsonAtomic(filename, JSON.stringify(generated), { private: true, durable: true })
      log.info("generated VAPID key pair")
      return generated
    })().catch((error) => {
      const instanceState = runtimeState()

      // Allow a later caller to retry generation after a transient failure.
      instanceState.vapidInit = undefined
      instanceState.vapidInitHome = undefined
      throw error
    })
    return instanceState.vapidInit
  }
}
