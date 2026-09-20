import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"

test.each([true, false])(
  "an eligible cohort activates before history is imported (archived=%s)",
  async (archived) => {
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
    import { Session } from ${JSON.stringify(path.join(harness, "session/index.ts"))};
    import { Scope } from ${JSON.stringify(path.join(harness, "scope/index.ts"))};
    import { ScopeContext } from ${JSON.stringify(path.join(harness, "scope/context.ts"))};
    import { Identifier } from ${JSON.stringify(path.join(harness, "id/id.ts"))};
    const id = Identifier.ascending("session");
    async function write(key, value) {
      const file = path.join(Global.Path.data, ...key) + ".json";
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(value));
    }
    await write(["sessions", "home", id, "info"], {
      id, scope: { id: "home", type: "home" }, title: "cold archive", version: "3.0.22",
      time: { created: 1, updated: 2, ...( ${archived} ? { archived: 3 } : {}) },
      completionNotice: { unread: false, unreadCount: 0, silent: false }
    });
    await write(["session_index", id], { sessionID: id, scopeID: "home" });
    for (const [domain, migrations] of MigrationRegistry.list())
      await write(StoragePath.metaMigrationLogDomain(domain), Object.fromEntries(migrations.filter(m => m.id !== "20260919-settle-orphaned-tool-parts").map(m => [m.id, 1])));
    await using handle = await StorageMaintenance.open();
    if (handle.manifest.phase !== "active") throw new Error("Not active");
    if ((await SessionCompat.stats()).pending !== 1) throw new Error("Cold cohort did not remain deferred");
    const created = await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ title: "new work before history" }) });
    if (!created.id || (await SessionCompat.stats()).pending !== 1) throw new Error("New work waited for old history");
    await SessionCompat.requireImported(id);
    if ((await SessionCompat.stats()).imported !== 1) throw new Error("Touch did not converge");
    if ((await handle.store.verify()).issues.length) throw new Error("Imported store is inconsistent");
  `
    const env: Record<string, string | undefined> = { ...process.env, SYNERGY_HOME: tmp.path }
    delete env.SYNERGY_STORAGE_COMPAT_DEFER
    const child = Bun.spawn([process.execPath, "-e", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code, stderr).toBe(0)
  },
  30000,
)
