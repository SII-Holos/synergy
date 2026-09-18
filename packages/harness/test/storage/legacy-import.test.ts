import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LegacyJsonImporter } from "../../src/storage/legacy-import"
import { TransactionalStore } from "../../src/storage/transactional-store"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "legacy-import-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))

async function fixture() {
  const directory = path.join(root, crypto.randomUUID())
  const data = path.join(directory, "data")
  await fs.mkdir(data, { recursive: true })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory, "target.sqlite"),
    namespace: crypto.randomUUID(),
  })
  return { directory, data, store, backup: path.join(directory, "backup") }
}

async function json(root: string, key: string[], value: unknown) {
  const target = path.join(root, ...key) + ".json"
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, JSON.stringify(value))
  return target
}

test("reports real inventory work before backup and advances each upgrade stage", async () => {
  const { store, data, backup } = await fixture()
  try {
    for (let index = 0; index < 3; index++) await json(data, ["notes", "scope", String(index)], { index })
    const progress: Array<{ stage: string; current: number; total: number; bytes: number }> = []
    const importer = new LegacyJsonImporter({
      dataRoot: data,
      backupRoot: backup,
      store,
      progress: (value) => {
        progress.push({ ...value })
        if (value.stage === "scan") expect(Bun.file(path.join(backup, "manifest.json")).size).toBe(0)
      },
    })
    await importer.run()
    await importer.retire()
    expect(progress[0]).toMatchObject({ stage: "scan", current: 0 })
    expect(progress.filter((value) => value.stage === "scan").at(-1)?.current).toBe(3)
    for (const stage of ["backup", "inventory", "owners", "import", "verify", "activate"]) {
      const events = progress.filter((value) => value.stage === stage)
      expect(events[0]?.current).toBe(0)
      expect(events.at(-1)?.current).toBe(3)
    }
  } finally {
    await store.close()
  }
})

test("backs up and imports historical records without dropping unloaded fields or migration ledgers", async () => {
  const fixtureData = await fixture()
  const { store, data, backup } = fixtureData
  try {
    const session = {
      id: "session",
      scope: { id: "scope" },
      title: "old",
      time: { created: 1, updated: 2 },
      unknownOwner: { value: 2 },
    }
    await json(data, ["sessions", "scope", "session", "info"], session)
    await json(data, ["meta", "migration", "log-workflows"], { historical: 123 })
    await json(data, ["auth", "provider-auth"], { private: "must-not-become-a-record" })
    const importer = new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store })
    const result = await importer.run()
    expect(result.imported).toBe(2)
    expect(result.quarantined).toBe(0)
    expect(await store.read<Record<string, unknown>>(["sessions", "scope", "session", "info"])).toEqual(session)
    expect(await store.read<Record<string, unknown>>(["meta", "migration", "log-workflows"])).toEqual({
      historical: 123,
    })
    expect(await store.readMany([["auth", "provider-auth"]])).toEqual([undefined])
    expect(await Bun.file(path.join(backup, "data", "sessions", "scope", "session", "info.json")).json()).toEqual(
      session,
    )
    expect(await Bun.file(path.join(data, "sessions", "scope", "session", "info.json")).exists()).toBe(true)
    expect(await importer.run()).toEqual(result)
  } finally {
    await store.close()
  }
})

test("quarantines malformed evidence with original bytes and blocks the affected session", async () => {
  const { store, data, backup } = await fixture()
  try {
    const target = await json(data, ["sessions", "scope", "broken", "messages", "message", "info"], {})
    await Bun.write(target, "{broken-json")
    const good = { id: "good", scope: { id: "scope" }, title: "retained", time: { created: 1, updated: 2 } }
    await json(data, ["sessions", "scope", "good", "info"], good)
    const result = await new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store }).run()
    expect(result.quarantined).toBe(1)
    expect(await Bun.file(path.join(backup, "data", path.relative(data, target))).text()).toBe("{broken-json")
    expect(await store.read<Record<string, unknown>>(["storage_recovery", "sessions", "broken", "info"])).toMatchObject(
      { blocked: true },
    )
    expect(await store.read<Record<string, unknown>>(["sessions", "scope", "good", "info"])).toEqual(good)
  } finally {
    await store.close()
  }
})

test("resumes after interruption without overwriting committed imported data", async () => {
  const { store, data, backup } = await fixture()
  try {
    for (let index = 0; index < 5; index++) await json(data, ["notes", "scope", `note-${index}`], { index })
    let interrupted = false
    const importer = new LegacyJsonImporter({
      dataRoot: data,
      backupRoot: backup,
      store,
      progress: (progress) => {
        if (progress.stage === "import" && progress.current === 2) {
          interrupted = true
          throw new Error("interrupted")
        }
      },
    })
    const failure = await importer.run().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ message: "interrupted" })
    expect(interrupted).toBe(true)
    const result = await new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store }).run()
    expect(result.imported).toBe(5)
    expect(await store.list(["notes", "scope"])).toHaveLength(5)
  } finally {
    await store.close()
  }
})

test("refuses source changes after backup instead of mixing historical snapshots", async () => {
  const { store, data, backup } = await fixture()
  try {
    const target = await json(data, ["notes", "scope", "note"], { value: 1 })
    const importer = new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store })
    await importer.run()
    await Bun.write(target, JSON.stringify({ value: 2 }))
    const failure = await importer.run().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ name: "StorageIntegrityError" })
    expect(await store.read<Record<string, unknown>>(["notes", "scope", "note"])).toEqual({ value: 1 })
  } finally {
    await store.close()
  }
})

test("backup retains workspace symlinks, read-only evidence and global configuration", async () => {
  const { store, data, backup, directory } = await fixture()
  try {
    await fs.mkdir(path.join(data, "worktree"), { recursive: true })
    await fs.symlink("unmounted-volume", path.join(data, "worktree", "linked"))
    await Bun.write(path.join(data, "artifact"), "read-only evidence")
    await fs.chmod(path.join(data, "artifact"), 0o444)
    await Bun.write(path.join(directory, "config", "synergy.d", "10-models.jsonc"), '{"model":"old-model"}')
    const result = await new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store }).run()
    expect(result.retained).toBe(3)
    expect(await fs.readlink(path.join(backup, "data", "worktree", "linked"))).toBe("unmounted-volume")
    expect(await Bun.file(path.join(backup, "data", "artifact")).text()).toBe("read-only evidence")
    expect(
      await Bun.file(path.join(backup, "data", "@home", "config", "synergy.d", "10-models.jsonc")).text(),
    ).toContain("old-model")
    expect(await Bun.file(path.join(backup, "inventory.ndjson")).text()).toContain('"linkTarget":"unmounted-volume"')
  } finally {
    await store.close()
  }
})

for (const key of [
  ["projects", "broken"],
  ["meta", "migration", "log-session"],
]) {
  test(`corrupt global authority blocks activation and repeated resume: ${key.join("/")}`, async () => {
    const { store, data, backup } = await fixture()
    try {
      const target = await json(data, key, {})
      await Bun.write(target, "{broken")
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(new LegacyJsonImporter({ dataRoot: data, backupRoot: backup, store }).run()).rejects.toThrow()
      expect(await Bun.file(path.join(backup, "data", path.relative(data, target))).text()).toBe("{broken")
      expect(await Bun.file(target).text()).toBe("{broken")
    } finally {
      await store.close()
    }
  })
}
