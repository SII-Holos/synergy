import fs from "node:fs/promises"
import path from "node:path"
import webpush from "web-push"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Global } from "../global"
import { PushTypes } from "./types"
import { Log } from "../util/log"

export namespace PushStore {
  const log = Log.create({ service: "push.store" })

  // Subscription endpoints + p256dh/auth and the VAPID private key are
  // credential material: together they allow authenticated, encrypted pushes
  // to registered devices. Persist them owner-only, like the provider auth
  // stores (api-key.ts writes its store through a 0600 handle).
  function credentialFile(key: string[]): string {
    return path.join(Global.Path.data, ...key) + ".json"
  }

  async function writeCredential<T>(key: string[], content: T): Promise<void> {
    await Storage.write(key, content)
    await fs.chmod(credentialFile(key), 0o600).catch(() => undefined)
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
    const existing = await findByEndpoint(input.endpoint)
    const record: PushTypes.Subscription = {
      id: existing?.id ?? `push_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      endpoint: input.endpoint,
      keys: input.keys,
      ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
      created: existing?.created ?? Date.now(),
      categories: input.categories ?? existing?.categories ?? PushTypes.DEFAULT_CATEGORIES,
    }
    await writeCredential(StoragePath.pushSubscription(record.id), record)
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
    await writeCredential(StoragePath.pushSubscription(id), { ...existing, categories })
  }

  // Memoized first-use generation keyed by the data home: two concurrent
  // callers must observe the same key pair (otherwise one subscribes with a
  // public key the persisted private key no longer backs), and a different
  // home (isolated test fixture) must not inherit another home's keys.
  let vapidInitHome: string | undefined
  let vapidInit: Promise<{ publicKey: string; privateKey: string }> | undefined

  /**
   * VAPID server keys. Generated once on first use and persisted owner-only;
   * the private key is a credential — never logged, exported, or returned by
   * any route.
   */
  export function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    const home = Global.Path.data
    if (vapidInit && vapidInitHome === home) return vapidInit
    vapidInitHome = home
    vapidInit = (async () => {
      const existing = await Storage.read<{ publicKey: string; privateKey: string }>(StoragePath.pushVapid()).catch(
        () => undefined,
      )
      if (existing?.publicKey && existing?.privateKey) return existing
      const generated = webpush.generateVAPIDKeys()
      await writeCredential(StoragePath.pushVapid(), generated)
      log.info("generated VAPID key pair")
      return generated
    })().catch((error) => {
      // Allow a later caller to retry generation after a transient failure.
      vapidInit = undefined
      vapidInitHome = undefined
      throw error
    })
    return vapidInit
  }
}
