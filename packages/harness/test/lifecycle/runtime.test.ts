import { expect, test } from "bun:test"
import path from "node:path"
import { RuntimeHandle, type RuntimeComposition } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StoragePath } from "../../src/storage/path"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutPending } from "../../src/session/rollout/pending"
import type { RolloutSchema } from "../../src/session/rollout/schema"
import { runtimeHome } from "../support/runtime-home"

const composition: RuntimeComposition = { register() {} }

for (const fails of [false, true]) {
  test(`shutdown preserves pending recovery until transport stops (failure=${fails})`, async () => {
    await using fixture = await runtimeHome()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(fixture.host.root, "borrowed.sqlite"),
      namespace: "borrowed",
    })
    const owner: RolloutSchema.Owner = { kind: "operation", scopeID: "test", operationID: crypto.randomUUID() }
    let ownersAtStop: RolloutSchema.Owner[] | undefined
    const runtime = await RuntimeHandle.open({
      host: fixture.host,
      storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
      mode: "oneshot",
      composition: {
        register() {},
        services: () => ({
          transport: {
            closeAdmission() {},
            listen: () => ({
              async stop() {
                ownersAtStop = (await RolloutPending.tracked())?.owners
                if (fails) throw new Error("transport stop failed")
              },
            }),
          },
        }),
      },
    })
    try {
      await runtime.run(() => RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "pending" } }))
      if (fails) await expect(runtime.close()).rejects.toThrow("Synergy runtime cleanup failed")
      else await runtime.close()
      expect(ownersAtStop).toContainEqual(owner)
      const pending = await store.snapshot(
        async (reader) =>
          (await reader.read<{ owners: RolloutSchema.Owner[] }>(StoragePath.rolloutRecoveryPending()))?.owners,
      )
      if (fails) expect(pending).toContainEqual(owner)
      else expect(pending).toEqual([])
      await store.transaction((transaction) => transaction.write(["probe"], { usable: true }))
      expect(await store.snapshot((reader) => reader.read<{ usable: boolean }>(["probe"]))).toEqual({ usable: true })
    } finally {
      await runtime.close().catch(() => {})
      await store.close()
    }
  }, 30_000)
}

test("runtime rejects duplicate home and storage ownership without closing the borrowed store", async () => {
  await using a = await runtimeHome()
  await using b = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(a.host.root, "borrowed.sqlite"),
    namespace: "borrowed",
  })
  const storage = { kind: "borrowed" as const, handle: { store, artifactDirectory: path.join(a.host.root, "data") } }
  const runtime = await RuntimeHandle.open({ host: a.host, storage, composition, mode: "oneshot" })
  try {
    expect(runtime.server).toBeUndefined()
    await expect(RuntimeHandle.open({ host: a.host, storage, composition, mode: "oneshot" })).rejects.toThrow(
      "already owns",
    )
    await expect(RuntimeHandle.open({ host: b.host, storage, composition, mode: "oneshot" })).rejects.toThrow(
      "already owns this storage",
    )
    await store.transaction((transaction) => transaction.write(["probe"], true))
    await Promise.all([runtime.close(), runtime.close()])
    const reopened = await RuntimeHandle.open({ host: b.host, storage, composition, mode: "oneshot" })
    await reopened.close()
  } finally {
    await runtime.close()
    await store.close()
  }
}, 30_000)

test("startup failure disposes initialized resources and releases home ownership", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "borrowed.sqlite"),
    namespace: "borrowed",
  })
  const storage = {
    kind: "borrowed" as const,
    handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
  }
  const calls: string[] = []
  try {
    await expect(
      RuntimeHandle.open({
        host: fixture.host,
        storage,
        mode: "oneshot",
        composition: {
          register() {},
          services: () => ({
            initializeExtensions: async () => {
              throw new Error("extension initialization failed")
            },
            disposeExtensions: async () => {
              calls.push("dispose")
            },
          }),
        },
      }),
    ).rejects.toThrow("extension initialization failed")
    expect(calls).toEqual(["dispose"])
    const reopened = await RuntimeHandle.open({ host: fixture.host, storage, composition, mode: "oneshot" })
    await reopened.close()
  } finally {
    await store.close()
  }
}, 30_000)

test("an aborted open drains a late owned storage acquisition and releases ownership", async () => {
  await using fixture = await runtimeHome()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let store: TransactionalStore | undefined
  const pending = RuntimeHandle.open({
    host: fixture.host,
    composition,
    mode: "oneshot",
    signal: controller.signal,
    storage: {
      kind: "owned",
      async open() {
        store = await TransactionalStore.open({
          backend: "sqlite",
          filename: path.join(fixture.host.root, "owned.sqlite"),
          namespace: "owned",
        })
        ready.resolve()
        await release.promise
        return {
          handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
          needsValidation: false,
          async activate() {},
        }
      },
    },
  })
  await ready.promise
  controller.abort(new Error("startup cancelled"))
  release.resolve()
  await expect(pending).rejects.toThrow("startup cancelled")
  await expect(store!.snapshot((reader) => reader.read<{ usable: boolean }>(["probe"]))).rejects.toThrow("closed")
  const reopened = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "owned.sqlite"),
    namespace: "owned",
  })
  try {
    await using runtime = await RuntimeHandle.open({
      host: fixture.host,
      composition,
      mode: "oneshot",
      storage: {
        kind: "borrowed",
        handle: { store: reopened, artifactDirectory: path.join(fixture.host.root, "data") },
      },
    })
    expect(runtime.status).toBe("ready")
  } finally {
    await reopened.close()
  }
}, 30_000)

test("a failing transport admission hook cannot prevent resource cleanup or ownership release", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "borrowed.sqlite"),
    namespace: "borrowed",
  })
  const storage = {
    kind: "borrowed" as const,
    handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
  }
  const calls: string[] = []
  const runtime = await RuntimeHandle.open({
    host: fixture.host,
    storage,
    mode: "oneshot",
    composition: {
      register() {},
      services: () => ({
        transport: {
          closeAdmission() {
            throw new Error("admission failed")
          },
          listen: () => ({
            stop() {
              calls.push("stop")
            },
          }),
        },
        disposeExtensions: async () => {
          calls.push("dispose")
        },
      }),
    },
  })
  try {
    await expect(runtime.close()).rejects.toThrow("cleanup failed")
    expect(calls).toEqual(["stop", "dispose"])
    expect(runtime.status).toBe("closed")
    await using next = await RuntimeHandle.open({ host: fixture.host, storage, mode: "oneshot", composition })
    expect(next.status).toBe("ready")
  } finally {
    await store.close()
  }
}, 30_000)
