import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { PushStore } from "../../src/push/store"
import { PushTypes } from "../../src/push/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const VALID_ENDPOINT = "https://web.push.apple.com/push/v1/abc123"

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir()
  const previous = process.env.SYNERGY_TEST_HOME
  const home = path.join(tmp.path, "home")
  process.env.SYNERGY_TEST_HOME = home
  await fs.mkdir(home, { recursive: true })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "push-test",
    filename: path.join(home, "authority.sqlite"),
  })
  try {
    return await Storage.provide({ store, artifactDirectory: path.join(home, ".synergy", "data") }, () =>
      ScopeContext.provide({ scope: Scope.home(), fn }),
    )
  } finally {
    await store.close()
    if (previous === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = previous
  }
}

describe("PushStore", () => {
  test("preserves the existing VAPID credential when authority moves to SQL", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        const pair = { publicKey: "existing-public-key", privateKey: "existing-private-key" }
        await Storage.writeJsonAtomic(path.join(Global.Path.data, "push/vapid.json"), JSON.stringify(pair), {
          private: true,
        })
        expect(await PushStore.vapidKeys()).toEqual(pair)
        expect(await Storage.readMany([StoragePath.pushVapid()])).toEqual([undefined])
      })
    }))

  test("round-trips subscriptions", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        const created = await PushStore.upsert({
          endpoint: VALID_ENDPOINT,
          keys: { p256dh: "key-p256dh", auth: "key-auth" },
          deviceLabel: "iPhone",
        })
        expect(created.categories).toEqual(PushTypes.DEFAULT_CATEGORIES)
        expect(created.deviceLabel).toBe("iPhone")

        const all = await PushStore.list()
        expect(all).toHaveLength(1)
        expect(all[0]!.endpoint).toBe(VALID_ENDPOINT)
        expect(all[0]!.keys).toEqual({ p256dh: "key-p256dh", auth: "key-auth" })
      })
    }))

  test("upsert is idempotent by endpoint", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        const first = await PushStore.upsert({
          endpoint: VALID_ENDPOINT,
          keys: { p256dh: "a", auth: "b" },
        })
        const second = await PushStore.upsert({
          endpoint: VALID_ENDPOINT,
          keys: { p256dh: "c", auth: "d" },
          deviceLabel: "iPhone 15",
          categories: { completion: false, error: true, input: false },
        })
        expect(second.id).toBe(first.id)
        expect(second.created).toBe(first.created)

        const all = await PushStore.list()
        expect(all).toHaveLength(1)
        expect(all[0]!.keys).toEqual({ p256dh: "c", auth: "d" })
        expect(all[0]!.categories).toEqual({ completion: false, error: true, input: false })
      })
    }))

  test("removes by endpoint and reports missing id", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        await PushStore.upsert({ endpoint: VALID_ENDPOINT, keys: { p256dh: "a", auth: "b" } })
        await PushStore.removeByEndpoint(VALID_ENDPOINT)
        expect(await PushStore.list()).toHaveLength(0)
        expect(await PushStore.removeById("push_missing")).toBe(false)
        await PushStore.removeByEndpoint("https://fcm.googleapis.com/fcm/send/none")
        expect(await PushStore.list()).toHaveLength(0)
      })
    }))

  test("generates VAPID keys once and reuses them", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        const first = await PushStore.vapidKeys()
        expect(first.publicKey).toBeTruthy()
        expect(first.privateKey).toBeTruthy()
        const persisted = await Bun.file(path.join(Global.Path.data, "push/vapid.json")).json()
        expect(persisted).toEqual(first)
        const second = await PushStore.vapidKeys()
        expect(second).toEqual(first)
      })
    }))

  test("concurrent first-use VAPID requests resolve to the same key pair", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        const [first, second, third] = await Promise.all([
          PushStore.vapidKeys(),
          PushStore.vapidKeys(),
          PushStore.vapidKeys(),
        ])
        expect(first).toEqual(second)
        expect(second).toEqual(third)
      })
    }))

  test("VAPID key and subscription records are persisted owner-only (0600)", () =>
    runtime.run(async () => {
      await withIsolatedHome(async () => {
        // Stat through Global.Path.data (the same resolution the store uses) —
        // the root getter caches the first resolved home for the process.
        const dataRoot = path.dirname(path.join(Global.Path.data, "x"))
        await PushStore.vapidKeys()
        const sub = await PushStore.upsert({ endpoint: VALID_ENDPOINT, keys: { p256dh: "a", auth: "b" } })
        expect(await PushStore.list()).toHaveLength(1)

        if (process.platform !== "win32") {
          const vapidMode = (await fs.stat(path.join(dataRoot, "push/vapid.json"))).mode
          expect(vapidMode & 0o777).toBe(0o600)
          const store = Storage.current().store
          if (store.options.backend !== "sqlite") throw new Error("Expected isolated SQLite fixture")
          expect((await fs.stat(store.options.filename)).mode & 0o777).toBe(0o600)
          expect(await Bun.file(path.join(dataRoot, `push/subscriptions/${sub.id}.json`)).exists()).toBe(false)
          expect(await Storage.read(StoragePath.pushSubscription(sub.id))).toMatchObject({ id: sub.id })
        }
      })
    }))
})

afterRuntimeTests(() => runtime.close())
