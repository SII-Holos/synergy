import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"

test("an up-to-date archived cohort activates with deferred records and remains importable", async () => {
  await using tmp = await tmpdir()
  const harness = new URL("../../src/", import.meta.url).pathname
  const script = `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { StorageMaintenance } from ${JSON.stringify(path.join(harness, "storage/maintenance.ts"))};
    import { MigrationRegistry } from ${JSON.stringify(path.join(harness, "migration/registry.ts"))};
    import { StoragePath } from ${JSON.stringify(path.join(harness, "storage/path.ts"))};
    import { Global } from ${JSON.stringify(path.join(harness, "global/index.ts"))};
    import { SessionCompat } from ${JSON.stringify(path.join(harness, "session/compat-import.ts"))};
    import { Identifier } from ${JSON.stringify(path.join(harness, "id/id.ts"))};
    const id = Identifier.ascending("session");
    async function write(key, value) {
      const file = path.join(Global.Path.data, ...key) + ".json";
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(value));
    }
    await write(["sessions", "home", id, "info"], {
      id, scope: { id: "home", type: "home" }, title: "cold archive", version: "3.0.22",
      time: { created: 1, updated: 2, archived: 3 },
      completionNotice: { unread: false, unreadCount: 0, silent: false }
    });
    await write(["session_index", id], { sessionID: id, scopeID: "home" });
    for (const [domain, migrations] of MigrationRegistry.list())
      await write(StoragePath.metaMigrationLogDomain(domain), Object.fromEntries(migrations.map(m => [m.id, 1])));
    await using handle = await StorageMaintenance.open();
    if (handle.manifest.phase !== "active") throw new Error("Not active");
    if ((await SessionCompat.stats()).pending !== 1) throw new Error("Cold cohort did not remain deferred");
    await SessionCompat.requireImported(id);
    if ((await SessionCompat.stats()).imported !== 1) throw new Error("Touch did not converge");
    if ((await handle.store.verify()).issues.length) throw new Error("Imported store is inconsistent");
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, SYNERGY_HOME: tmp.path, SYNERGY_STORAGE_COMPAT_DEFER: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  expect(code, stderr).toBe(0)
}, 30000)
