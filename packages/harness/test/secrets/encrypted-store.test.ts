import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { SecretVault } from "../../src/secrets/vault"
import { encryptedSecretVault } from "../../src/secrets/encrypted-store"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestOptions } from "../support/storage-backends"
import { storageTestRuntime } from "../support/storage-runtime"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "encrypted-vault-"))
  const options = storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") })
  let store = await TransactionalStore.open(options)
  let runtime = await storageTestRuntime()
  let authority = ["tenant-one", "profile-one"]
  let version = "key-one"
  const keys = new Map([[version, randomBytes(32)]])
  const install = () =>
    runtime.run(() =>
      SecretVault.registerStorage(
        encryptedSecretVault({
          authority,
          keys: {
            async current() {
              const key = keys.get(version)
              if (!key) throw new Error("key unavailable")
              return { version, key }
            },
            async resolve(id) {
              const key = keys.get(id)
              if (!key) throw new Error("key unavailable")
              return key
            },
          },
        }),
      ),
    )
  install()
  return {
    keys,
    store: () => store,
    run<T>(body: () => Promise<T>) {
      return runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(root, "unused") }, body))
    },
    async reopen(nextAuthority = authority) {
      await runtime.close()
      await store.close()
      store = await TransactionalStore.open(options)
      runtime = await storageTestRuntime()
      authority = nextAuthority
      install()
    },
    rotate() {
      version = "key-two"
      keys.set(version, randomBytes(32))
    },
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("encrypted secrets recover with an empty Host and never enter database records or receipts as plaintext", async () => {
  await using f = await fixture()
  const value = "fixture-sensitive-content"
  const id = await f.run(async () => (await SecretVault.register(value, { kind: "user" })).id)
  const encoded = await f.store().snapshot(async (tx) => {
    const rows = []
    for await (const row of tx.exportEntries()) rows.push(row)
    return JSON.stringify(rows)
  })
  expect(encoded).not.toContain(value)
  expect(encoded).not.toContain('"fingerprint":')
  await f.reopen()
  expect(await f.run(() => SecretVault.reveal(id))).toBe(value)
})

test("a missing key fails closed without replacing the existing vault", async () => {
  await using f = await fixture()
  const id = await f.run(async () => (await SecretVault.register("fixture-kept", { kind: "user" })).id)
  const before = await f.store().read(["secrets", "encrypted-vault"])
  const key = f.keys.get("key-one")!
  f.keys.delete("key-one")
  await expect(f.run(() => SecretVault.reveal(id))).rejects.toThrow("unavailable")
  await expect(f.run(() => SecretVault.register("fixture-new", { kind: "user" }))).rejects.toThrow("unavailable")
  expect(JSON.stringify(await f.store().read(["secrets", "encrypted-vault"]))).toBe(JSON.stringify(before))
  f.keys.set("key-one", key)
  expect(await f.run(() => SecretVault.reveal(id))).toBe("fixture-kept")
})

test("authenticated encryption rejects copied entries from another profile or identifier", async () => {
  await using f = await fixture()
  const id = await f.run(async () => (await SecretVault.register("fixture-bound", { kind: "user" })).id)
  await f.reopen(["tenant-one", "profile-two"])
  await expect(f.run(() => SecretVault.reveal(id))).rejects.toThrow("authentication")
  await f.reopen(["tenant-one", "profile-one"])
  const original = await f
    .store()
    .read<{ version: number; entries: Record<string, unknown> }>(["secrets", "encrypted-vault"])
  await f.store().write(["secrets", "encrypted-vault"], { ...original, entries: { another: original.entries[id] } })
  await expect(f.run(() => SecretVault.list())).rejects.toThrow("authentication")
})

test("versioned keys rotate all entries atomically and concurrent resolve enforces policy", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const { id } = await SecretVault.register(
      "fixture-limited",
      { kind: "user" },
      { policy: { tools: ["bash"], maxResolvesPerSession: 1 } },
    )
    f.rotate()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => SecretVault.resolve(id, { sessionID: "session", tool: "bash" })),
    )
    expect(results.filter((r) => "value" in r)).toHaveLength(1)
    expect(results.filter((r) => "denied" in r)).toHaveLength(7)
    f.keys.delete("key-one")
    expect(await SecretVault.reveal(id)).toBe("fixture-limited")
    expect(await SecretVault.resolve(id, { sessionID: "other", tool: "network" })).toEqual({
      denied: true,
      reason: "policy",
    })
  })
})

test("independent Runtime instances in one process cannot observe each other's vault", async () => {
  await using first = await fixture()
  await using second = await fixture()
  const [a, b] = await Promise.all([
    first.run(() => SecretVault.register("fixture-identity-a", { kind: "user" })),
    second.run(() => SecretVault.register("fixture-identity-b", { kind: "user" })),
  ])
  expect(await first.run(() => SecretVault.reveal(b.id))).toBeUndefined()
  expect(await second.run(() => SecretVault.reveal(a.id))).toBeUndefined()
  expect(await first.run(() => SecretVault.reveal(a.id))).toBe("fixture-identity-a")
  await expect(first.run(() => Storage.transaction(() => SecretVault.reveal(a.id)))).rejects.toThrow(
    "outside business transactions",
  )
})
