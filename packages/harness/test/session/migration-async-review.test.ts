import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { runMigrations, getMigrationStatus } from "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"
import { SessionCompat } from "../../src/session/compat-import"
import { SessionManager } from "../../src/session/manager"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutMigration } from "../../src/session/rollout/migration"
import { StorageCompat } from "../../src/storage/compat"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { RolloutPending } from "../../src/session/rollout/pending"
import { SegmentedBackup } from "../../src/storage/segmented-backup"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "migration-async-review-"))
  const data = path.join(root, "data")
  await fs.mkdir(data)
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: crypto.randomUUID(),
    filename: path.join(root, "target.sqlite"),
  })
  const id = Identifier.ascending("session")
  const info = {
    id,
    scope: { id: "home", type: "home" },
    title: "deferred archive",
    version: "3.0.22",
    time: { created: 1000, updated: 2000, archived: 3000 },
    completionNotice: { unread: false, silent: false, unreadCount: 0 },
  }
  const key = StoragePath.sessionInfo(Identifier.asScopeID("home"), id)
  const source = path.join(data, ...key) + ".json"
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, JSON.stringify(info))
  return {
    store,
    data,
    id,
    info,
    key,
    source,
    run<T>(fn: () => T) {
      return Storage.provide({ store, artifactDirectory: data }, fn)
    },
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("a rolled-back caller cannot retire the only live copy of a deferred session", async () => {
  await using f = await fixture()
  await StorageCompat.seedLocators(f.store, f.data)
  await f.run(async () => {
    await expect(
      Storage.transaction(async () => {
        expect((await SessionManager.requireSession(f.id)).id).toBe(f.id)
        throw new Error("caller business mutation failed")
      }),
    ).rejects.toThrow("before opening a business transaction")
    const [canonical] = await f.store.readMany([f.key])
    const legacyExists = await Bun.file(f.source).exists()
    expect({ canonicalExists: canonical !== undefined, legacyExists }).not.toEqual({
      canonicalExists: false,
      legacyExists: false,
    })
    expect((await SessionCompat.requireImported(f.id)).status).toBe("imported")
    await expect(
      Storage.transaction(async () => {
        expect((await SessionManager.requireSession(f.id)).id).toBe(f.id)
        throw new Error("caller business mutation failed")
      }),
    ).rejects.toThrow("caller business mutation failed")
    expect(await f.store.read(f.key)).toMatchObject({ id: f.id })
  })
})

test("a failed parallel rollout migration drains the other owner before returning", async () => {
  await using f = await fixture()
  const badID = Identifier.ascending("session")
  const badKey = StoragePath.sessionInfo(Identifier.asScopeID("home"), badID)
  await f.store.write(f.key, f.info)
  await f.store.write(badKey, { ...f.info, id: badID, cortex: { status: "invalid" } })
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const badRead = Promise.withResolvers<void>()
  const read = Storage.read.bind(Storage)
  const fault = spyOn(Storage, "read").mockImplementation(async <T = unknown>(key: string[]): Promise<T> => {
    if (key.join("/") === f.key.join("/")) {
      held.resolve()
      await release.promise
    }
    if (key.join("/") === badKey.join("/")) {
      await held.promise
      const result = await read<T>(key)
      badRead.resolve()
      return result
    }
    return read<T>(key)
  })
  let settled = false
  let completed = 0
  const ownerDone = Promise.withResolvers<void>()
  const migration = f
    .run(() =>
      RolloutMigration.migration.up(() => {
        completed++
        ownerDone.resolve()
      }),
    )
    .then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
  try {
    await badRead.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect({ settled, completed }).toEqual({ settled: false, completed: 0 })
  } finally {
    release.resolve()
    await migration
    await ownerDone.promise
    fault.mockRestore()
  }
})

test("migration progress is visible before deferred aggregates start staging", async () => {
  await using f = await fixture()
  await StorageCompat.seedLocators(f.store, f.data)
  const domain = "test-deferred-stage-progress-review"
  const events: string[] = []
  MigrationRegistry.register(domain, [
    {
      id: "20260919-deferred-stage-progress-review",
      description: "Observe deferred staging",
      async up() {},
    },
  ])
  const readFile = fs.readFile.bind(fs)
  const observe = spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === f.source) events.push("source-read")
    return readFile(...args)
  }) as typeof fs.readFile)
  try {
    await f.run(() =>
      runMigrations({
        targetDomain: domain,
        output: "silent",
        reporter: {
          started() {
            events.push("started")
          },
          progress() {
            events.push("progress")
          },
          summary() {
            events.push("summary")
          },
        },
      }),
    )
    expect(events).toContain("source-read")
    expect(events.indexOf("started")).toBeLessThan(events.indexOf("source-read"))
  } finally {
    observe.mockRestore()
    MigrationRegistry.unregister(domain)
  }
})

test("the central runner leaves historical cohorts pending until per-session upgrade and publication", async () => {
  await using f = await fixture()
  await StorageCompat.seedLocators(f.store, f.data)
  const domain = "test-session-cohort"
  let attempts = 0
  MigrationRegistry.register(domain, [
    {
      id: "cohort-one",
      description: "Upgrade one owner",
      scope: "session",
      async up() {},
      async upSession(owner) {
        expect(owner.sessionID).toBe(f.id)
        if (++attempts === 1) throw new Error("interrupted owner migration")
        await Storage.update(f.key, (info: { title: string }) => {
          info.title = "upgraded"
        })
      },
    },
  ])
  try {
    await f.run(async () => {
      await runMigrations({ targetDomain: domain, output: "silent" })
      expect((await getMigrationStatus(domain))[domain].pending).toHaveLength(1)
      expect(await Bun.file(f.source).exists()).toBe(true)
      await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("interrupted owner")
      expect((await SessionCompat.stats()).partial).toBe(1)
      await runMigrations({ targetDomain: domain, output: "silent" })
      await SessionCompat.requireImported(f.id)
      expect(await Storage.read(f.key)).toMatchObject({ title: "upgraded" })
      expect((await getMigrationStatus(domain))[domain].pending).toHaveLength(0)
      expect((await SessionCompat.stats()).imported).toBe(1)
    })
  } finally {
    MigrationRegistry.unregister(domain)
  }
})

test("catalog reads are independent of source files and recovery cannot declare an unresolved cohort clean", async () => {
  await using f = await fixture()
  await StorageCompat.seedLocators(f.store, f.data)
  await fs.rename(f.source, f.source + ".unavailable")
  await f.run(async () => {
    expect((await SessionCompat.mergePageIndex("home", { entries: [] })).entries[0].id).toBe(f.id)
    expect((await SessionCompat.catalogPage({ scopeID: "home", limit: 1 })).items[0].sessionID).toBe(f.id)
    expect((await SessionCompat.catalogPage({ scopeID: "another" })).items).toHaveLength(0)
    await RolloutPending.markClean()
    expect(await RolloutPending.tracked()).toBeUndefined()
  })
})

test("segmented import rejects a same-size change after sealing its independent backup", async () => {
  await using f = await fixture()
  const backup = new SegmentedBackup(f.data, "test-backup")
  await backup.freeze()
  await backup.global().create()
  await StorageCompat.seedLocators(f.store, backup.sourceRoot, backup.backupID)
  await backup.sealSession({ scopeID: "home", sessionID: f.id })
  const source = path.join(backup.sourceRoot, ...f.key) + ".json"
  const original = await fs.readFile(source, "utf8")
  await fs.writeFile(source, original.replace("deferred archive", "modified archive"))
  await f.run(async () => {
    await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("changed after backup")
    expect(await Bun.file(source).exists()).toBe(true)
    expect((await SessionCompat.stats()).imported).toBe(0)
  })
})

test("retry backoff lets a later healthy owner proceed after a transient import failure", async () => {
  await using f = await fixture()
  const bad = Identifier.ascending("session")
  const filename = path.join(f.data, "sessions/home", bad, "info.json")
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, JSON.stringify({ ...f.info, id: bad, time: { ...f.info.time, updated: 3000 } }))
  await StorageCompat.seedLocators(f.store, f.data)
  const readFile = fs.readFile.bind(fs)
  const fault = spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === filename)
      return Promise.reject(Object.assign(new Error("temporary failure"), { code: "EACCES" }))
    return readFile(...args)
  }) as typeof fs.readFile)
  try {
    await f.run(async () => {
      expect(await SessionCompat.importBatch(1)).toBe(0)
      expect(await SessionCompat.importBatch(1)).toBe(1)
      expect((await SessionCompat.stats()).imported).toBe(1)
    })
  } finally {
    fault.mockRestore()
  }
})

test("a spent scheduling deadline still lets one owner progress after catalog discovery", async () => {
  await using f = await fixture()
  const other = Identifier.ascending("session")
  await Bun.write(path.join(f.data, "sessions/home", other, "info.json"), JSON.stringify({ ...f.info, id: other }))
  await StorageCompat.seedLocators(f.store, f.data)
  await f.run(async () => {
    expect(await SessionCompat.importBatch(2, { deadline: Date.now() - 1 })).toBe(1)
    expect((await SessionCompat.stats()).pending).toBe(1)
  })
})

test("a missing sealed message cannot publish a truncated deferred owner", async () => {
  await using f = await fixture()
  const messageID = Identifier.ascending("message")
  const relative = `sessions/home/${f.id}/messages/${messageID}/info.json`
  await Bun.write(
    path.join(f.data, relative),
    JSON.stringify({
      id: messageID,
      sessionID: f.id,
      role: "user",
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1000 },
    }),
  )
  const backup = new SegmentedBackup(f.data, "missing-sealed-message")
  await backup.freeze()
  await backup.global().create()
  await StorageCompat.seedLocators(f.store, backup.sourceRoot, backup.backupID)
  await backup.sealSession({ scopeID: "home", sessionID: f.id })
  await fs.rm(path.join(backup.sourceRoot, relative))
  await f.run(async () => {
    await expect(SessionCompat.requireImported(f.id)).rejects.toThrow("sealed backup")
    expect((await SessionCompat.stats()).imported).toBe(0)
    expect((await Storage.readMany([StoragePath.sessionIndex(f.id)]))[0]).toBeUndefined()
  })
})

test("derived migrations publish indexes only after owner recovery", async () => {
  await using f = await fixture()
  await StorageCompat.seedLocators(f.store, f.data)
  await f.store.write(["compat_import", "cohorts", "session", "20260730-session-nav-channel-provider-fields"], {
    domain: "session",
    id: "20260730-session-nav-channel-provider-fields",
    residentComplete: true,
  })
  const recover = RolloutRecovery.owner
  let recovered = false
  const observe = spyOn(RolloutRecovery, "owner").mockImplementation(async (...args) => {
    expect((await Storage.readMany([StoragePath.sessionIndex(f.id)]))[0]).toBeUndefined()
    const result = await recover(...args)
    recovered = true
    return result
  })
  try {
    await f.run(async () => {
      await SessionCompat.requireImported(f.id)
      expect(recovered).toBe(true)
      expect((await Storage.readMany([StoragePath.sessionIndex(f.id)]))[0]).toBeDefined()
    })
  } finally {
    observe.mockRestore()
  }
})
