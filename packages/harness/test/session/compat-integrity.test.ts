import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCompat } from "../../src/storage/compat"
import { StoragePortable } from "../../src/storage/portable"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SessionCompat } from "../../src/session/compat-import"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "compat-integrity-"))
  const data = path.join(root, "data")
  await fs.mkdir(data)
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    process.env.SYNERGY_TEST_POSTGRES_URL
      ? { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL }
      : { backend: "sqlite", namespace, filename: path.join(root, "target.sqlite") },
  )
  const handle = { store, artifactDirectory: data }
  const id = Identifier.ascending("session")
  const info = {
    id,
    scope: { id: "home", type: "home" },
    title: "deferred",
    version: "3.0.22",
    time: { created: 1000, updated: 2000 },
    completionNotice: { unread: false, silent: false, unreadCount: 0 },
  }
  const directory = path.join(data, "sessions", "home", id)
  async function write(relative: string, value: unknown) {
    const filename = path.join(directory, relative)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, typeof value === "string" ? value : JSON.stringify(value))
    return filename
  }
  await write("info.json", info)
  await StorageCompat.seedLocators(store, data)
  return {
    store,
    data,
    id,
    info,
    directory,
    write,
    async catalog() {
      const state = await store.read<StorageCompat.Info>(StorageCompat.infoKey)
      await store.write(StorageCompat.infoKey, { ...state, discovered: false })
      await StorageCompat.seedLocators(store, data)
    },
    run<T>(fn: () => T) {
      return Storage.provide(handle, fn)
    },
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("touch imports from the owning handle, preserves auxiliary files, and retains binary bytes", async () => {
  await using f = await fixture()
  await f.write("rollout/blobs/evidence.bin", "binary evidence")
  const auxiliary = await f.write("notes.txt", "unclassified evidence")
  await f.run(async () => {
    expect((await SessionCompat.requireImported(f.id)).status).toBe("imported")
    expect(
      new TextDecoder().decode(await Storage.readBinary(["sessions", "home", f.id, "rollout", "blobs", "evidence"])),
    ).toBe("binary evidence")
    expect(await Bun.file(auxiliary).text()).toBe("unclassified evidence")
    expect(await Bun.file(path.join(f.directory, "info.json")).exists()).toBe(false)
  })
})

test("pending endpoint resolution finds an aggregate before any endpoint index exists", async () => {
  await using f = await fixture()
  const endpoint = { kind: "channel" as const, channel: { type: "test", accountId: "account", chatId: "chat" } }
  await f.write("info.json", { ...f.info, endpoint })
  await f.catalog()
  await f.run(async () => {
    expect(await SessionManager.getSessionID(endpoint)).toBe(f.id)
    expect((await SessionManager.getSession(endpoint))?.id).toBe(f.id)
  })
})

test("pending projections never become persisted entries when a different session changes", async () => {
  await using f = await fixture()
  await f.run(async () => {
    expect((await Session.readPageIndex("home")).entries.map((entry) => entry.id)).toEqual([f.id])
    const other = Identifier.ascending("session")
    await Session.upsertPageIndexEntry("home", { id: other, created: 1, updated: 2, pinned: 0, archived: false })
    const persisted = await Storage.read<{ entries: { id: string }[] }>(
      StoragePath.sessionsPageIndex(Identifier.asScopeID("home")),
    )
    expect(persisted.entries.map((entry) => entry.id)).toEqual([other])
  })
})

test("malformed metadata is isolated from listings and missing sources remain blocked", async () => {
  await using f = await fixture()
  await f.write("info.json", { id: f.id, time: null })
  await f.catalog()
  await f.run(async () => {
    expect((await Session.readPageIndex("home")).entries).toEqual([])
    await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("quarantined historical data")
    expect(await Bun.file(path.join(f.directory, "info.json")).exists()).toBe(true)
  })
  await using missing = await fixture()
  await fs.rm(missing.directory, { recursive: true })
  await missing.run(async () => {
    await expect(SessionCompat.requireImported(missing.id)).rejects.toThrow("quarantined historical data")
    expect((await StorageCompat.readLocator(missing.store, missing.id))?.status).toBe("quarantined")
  })
})

test("source drift after a committed checkpoint is detected before retiring any original", async () => {
  await using f = await fixture()
  const infoFile = path.join(f.directory, "info.json")
  const oldBytes = await fs.readFile(infoFile)
  await f.store.write(StoragePath.sessionInfo(Identifier.asScopeID("home"), f.id), f.info)
  await f.store.write(
    StorageCompat.fileCheckpointKey(f.id, `sessions/home/${f.id}/info.json`),
    createHash("sha256").update(oldBytes).digest("hex"),
  )
  await f.store.write(StorageCompat.locatorKey(f.id), { sessionID: f.id, scopeID: "home", status: "partial" })
  await f.write("info.json", { ...f.info, title: "changed since checkpoint" })
  await f.run(async () => {
    await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("changed")
    expect(await Bun.file(infoFile).exists()).toBe(true)
    expect((await StorageCompat.readLocator(f.store, f.id))?.status).toBe("partial")
  })
})

test("the central runner imports deferred records before a migration owned by another domain", async () => {
  await using f = await fixture()
  const domain = "compat-integrity-fixture"
  const key = StoragePath.sessionInfo(Identifier.asScopeID("home"), f.id)
  MigrationRegistry.register(domain, [
    {
      id: "20260919-fixture-owner",
      description: "Migrate deferred fixture",
      async up() {
        const info = await Storage.read<typeof f.info>(key)
        await Storage.write(key, { ...info, title: "migrated by owner" })
      },
    },
  ])
  try {
    await f.run(async () => {
      expect((await runMigrations({ targetDomain: domain, output: "silent" })).completed).toBe(1)
      expect(await Bun.file(path.join(f.directory, "info.json")).exists()).toBe(true)
      await SessionCompat.requireImported(f.id)
      expect((await Storage.read<typeof f.info>(key)).title).toBe("migrated by owner")
    })
  } finally {
    MigrationRegistry.unregister(domain)
  }
})

test("failed owner migration preserves originals and does not mark the migration complete", async () => {
  await using f = await fixture()
  const domain = "compat-failed-fixture"
  MigrationRegistry.register(domain, [
    {
      id: "20260919-fixture-failure",
      description: "Fail fixture migration",
      async up() {
        throw new Error("owner migration failed")
      },
    },
  ])
  try {
    await f.run(async () => {
      await expect(runMigrations({ targetDomain: domain, output: "silent" })).rejects.toThrow("owner migration failed")
      expect(await Bun.file(path.join(f.directory, "info.json")).exists()).toBe(true)
      expect((await StorageCompat.readLocator(f.store, f.id))?.status).toBe("partial")
      expect((await Storage.readMany([StoragePath.metaMigrationLogDomain(domain)]))[0]).toBeUndefined()
      await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("owning domain migrations")
      MigrationRegistry.register("compat-unrelated-fixture", [])
      try {
        await runMigrations({ targetDomain: "compat-unrelated-fixture", output: "silent" })
        await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("owning domain migrations")
      } finally {
        MigrationRegistry.unregister("compat-unrelated-fixture")
      }
    })
  } finally {
    MigrationRegistry.unregister(domain)
  }
})

test("portable export refuses both pending and quarantined deferred aggregates", async () => {
  await using f = await fixture()
  for (const status of ["pending", "quarantined"] as const) {
    await f.store.write(StorageCompat.locatorKey(f.id), { sessionID: f.id, scopeID: "home", status })
    await expect(StoragePortable.exportFile(f.store, path.join(f.data, "export.ndjson"))).rejects.toThrow("Deferred")
  }
})

test("transient file reads remain retryable and do not quarantine the aggregate", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const fault = Object.assign(new Error("temporary read failure"), { code: "EIO" })
    const read = spyOn(fs, "readFile").mockRejectedValueOnce(fault)
    try {
      await expect(SessionCompat.requireImported(f.id)).rejects.toBe(fault)
      expect((await StorageCompat.readLocator(f.store, f.id))?.status).toBe("pending")
    } finally {
      read.mockRestore()
    }
    expect((await SessionCompat.requireImported(f.id)).status).toBe("imported")
  })
})

test("startup imports recovery-eligible sessions and leaves idle history deferred", async () => {
  await using active = await fixture()
  await active.write("info.json", { ...active.info, pendingReply: true })
  await active.catalog()
  await active.run(async () => {
    await SessionCompat.prepareRecovery()
    expect((await StorageCompat.readLocator(active.store, active.id))?.status).toBe("imported")
  })
  await using archived = await fixture()
  await archived.write("info.json", { ...archived.info, time: { ...archived.info.time, archived: 3000 } })
  await archived.catalog()
  await archived.run(async () => {
    await SessionCompat.prepareRecovery()
    expect((await StorageCompat.readLocator(archived.store, archived.id))?.status).toBe("pending")
  })
})

test("the background migrator retains its handle and its stop drains work before store closure", async () => {
  await using f = await fixture()
  const stop = f.run(() => SessionCompat.startBackgroundMigrator({ intervalMs: 1, budget: 1 }))
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await StorageCompat.readLocator(f.store, f.id))?.status === "imported") break
      await Bun.sleep(5)
    }
    expect((await StorageCompat.readLocator(f.store, f.id))?.status).toBe("imported")
  } finally {
    await stop()
  }
  await using untouched = await fixture()
  const cancel = untouched.run(() => SessionCompat.startBackgroundMigrator({ intervalMs: 100, budget: 1 }))
  await cancel()
  expect((await StorageCompat.readLocator(untouched.store, untouched.id))?.status).toBe("pending")
})

test("archived retired endpoints stay in canonical history and are omitted from projections", async () => {
  await using f = await fixture()
  const endpoint = { kind: "holos", agentId: "retired-agent" }
  await f.write("info.json", { ...f.info, endpoint, time: { ...f.info.time, archived: 3000 } })
  await f.run(async () => {
    expect((await Session.readPageIndex("home")).entries.map((entry) => entry.id)).toEqual([f.id])
    await SessionCompat.requireImported(f.id)
    const canonical = await Storage.read<{ endpoint: unknown }>(
      StoragePath.sessionInfo(Identifier.asScopeID("home"), f.id),
    )
    expect(canonical.endpoint).toEqual(endpoint)
    expect(await Storage.read(StoragePath.sessionIndex(f.id))).not.toHaveProperty("endpoint")
  })
})
