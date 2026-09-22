import { PackedBackup } from "../../src/storage/packed-backup"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { Storage } from "../../src/storage/storage"
import { StorageRecovery } from "../../src/storage/recovery"
import { migrations as sessionMigrations } from "../../src/session/migration"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test.each([
  { invalid: { time: null }, migrated: true },
  { invalid: { time: { created: 1700000000000 } }, migrated: true },
  { invalid: { scope: null }, migrated: true },
  { invalid: { time: null }, migrated: false },
])(
  "invalid historical session fields quarantine only that session during startup: %j",
  runtime.bind(async ({ invalid, migrated }) => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".synergy")
    const fixture = (await Bun.file(new URL("./fixtures/v3.0.22.json", import.meta.url)).json()) as {
      records: Array<{ key: string[]; value: Record<string, unknown> }>
    }
    const broken = fixture.records[0]
    const healthyID = "ses_00000000000000000000000002"
    const healthyKey = ["sessions", "home", healthyID, "info"]
    fixture.records.push({ key: healthyKey, value: { ...broken.value, id: healthyID } })
    Object.assign(broken.value, invalid)
    if (migrated)
      fixture.records.push({
        key: ["meta", "migration", "log-session"],
        value: Object.fromEntries(
          sessionMigrations
            .filter((migration) => !migration.id.startsWith("20260914"))
            .map((migration) => [migration.id, 1700000000000]),
        ),
      })
    for (const record of fixture.records) {
      const file = path.join(root, "data", ...record.key) + ".json"
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, JSON.stringify(record.value))
    }
    const entry = new URL("../../src/storage/maintenance.ts", import.meta.url).pathname
    const script = `
      import { StorageMaintenance } from ${JSON.stringify(entry)};
      import { RuntimeContext } from ${JSON.stringify(new URL("../../src/lifecycle/context.ts", import.meta.url).pathname)};
      import { registerHarness } from ${JSON.stringify(new URL("../../src/lifecycle/register.ts", import.meta.url).pathname)};
      const home = process.env.SYNERGY_HOME;
      const runtime = RuntimeContext.create({ home, root: home + "/.synergy", env: { ...process.env } });
      await runtime.run(async () => {
        registerHarness();
        await using handle = await StorageMaintenance.open();
        if (handle.manifest.phase !== "active") throw new Error("Upgrade did not activate");
      });
      runtime.dispose();
    `
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, SYNERGY_HOME: tmp.path },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, , code] = await Promise.all([
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
    }
    const handle = await StorageBootstrap.inspect(root)
    if (!handle) throw new Error("Upgraded dataset is absent")
    try {
      const blockedKey = ["storage_recovery", "sessions", broken.key[2], "info"]
      expect(await handle.store.read(blockedKey)).toMatchObject({ blocked: true, reason: "historical_data_gap" })
      expect(await handle.store.readMany([broken.key, ["session_index", broken.key[2]]])).toEqual([
        undefined,
        undefined,
      ])
      expect(await handle.store.readMany([fixture.records[2].key, fixture.records[3].key])).toEqual([
        undefined,
        undefined,
      ])
      expect(await handle.store.read(["session_index", healthyID])).toMatchObject({ scopeID: "home" })
      expect(await handle.store.read(healthyKey)).toMatchObject({ futureOwner: { retained: true } })
      const state = await handle.store.read<{ backup: string }>(["storage_import", "info"])
      const restored = path.join(tmp.path, "restored-data")
      await new PackedBackup({ dataRoot: path.join(root, "data"), backupRoot: state.backup }).restore(restored)
      expect(await Bun.file(path.join(restored, ...broken.key) + ".json").json()).toEqual(broken.value)
      await Storage.provide(handle, async () => {
        await StorageRecovery.load()
        expect(() => StorageRecovery.assertRunnable(broken.key[2])).toThrow("quarantined")
        expect(() => StorageRecovery.assertRunnable(healthyID)).not.toThrow()
      })
    } finally {
      await handle.store.close()
    }
  }),
  30000,
)

afterRuntimeTests(() => runtime.close())
