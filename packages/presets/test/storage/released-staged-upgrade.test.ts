import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

for (const held of [false, true]) {
  test(`the released 3.0.22 completion ledger admits new work before historical import (held=${held})`, async () => {
    await using tmp = await tmpdir()
    await using main = await tmpdir()
    await using additional = await tmpdir()
    const fixture = await Bun.file(
      new URL("../../../harness/test/storage/fixtures/v3.0.22.json", import.meta.url),
    ).json()
    const ledger = await Bun.file(new URL("./fixtures/v3.0.22-migration-ledger.json", import.meta.url)).json()
    const heldSessionID = "ses_00000000000000000000000002"
    const loopID = "bll_00000000000000000000000001"
    const projectID = "released-project"
    fixture.records.push({
      key: ["projects", projectID],
      value: {
        id: projectID,
        type: "project",
        name: "Released project",
        directory: main.path,
        worktree: main.path,
        sandboxes: [additional.path],
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    })
    if (held) {
      fixture.records.push({
        key: ["sessions", "home", heldSessionID, "info"],
        value: {
          ...fixture.records[0].value,
          id: heldSessionID,
          blueprint: { loopID, loopRole: "execution", phase: "waiting" },
        },
      })
      fixture.records.push({
        key: ["session_index", heldSessionID],
        value: { id: heldSessionID, scopeID: "home" },
      })
      fixture.records.push({
        key: ["blueprint_loops", "home", loopID],
        value: {
          id: loopID,
          noteID: "note_held",
          title: "Held Blueprint",
          sessionID: heldSessionID,
          auditAgent: "supervisor",
          scopeID: "home",
          status: "waiting",
          source: "user",
          time: { created: 1700000000000, updated: 1700000000000 },
        },
      })
    }
    const data = path.join(tmp.path, ".synergy", "data")
    for (const record of fixture.records) {
      const file = path.join(data, ...record.key) + ".json"
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(
        file,
        JSON.stringify(
          record.key.join("/") === "meta/migration/log"
            ? Object.fromEntries(ledger.completed.map((id: string) => [id, 1]))
            : record.value,
        ),
      )
    }
    const harness = new URL("../../../harness/src/", import.meta.url).pathname
    const registration = new URL("../../src/registration.ts", import.meta.url).pathname
    const script = `
    const { registerFullPreset } = await import(${JSON.stringify(registration)});
    const { RuntimeContext } = await import(${JSON.stringify(path.join(harness, "lifecycle/context.ts"))});
    const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime/host");
    const runtime = RuntimeContext.create(createLocalHost({ home: process.env.SYNERGY_HOME, root: ${JSON.stringify(path.join(tmp.path, ".synergy"))} }));
    await runtime.run(async () => {
    registerFullPreset();
    const { StorageMaintenance } = await import(${JSON.stringify(path.join(harness, "storage/maintenance.ts"))});
    const { SessionCompat } = await import(${JSON.stringify(path.join(harness, "session/compat-import.ts"))});
    const { Session } = await import(${JSON.stringify(path.join(harness, "session/index.ts"))});
    const { Scope } = await import(${JSON.stringify(path.join(harness, "scope/index.ts"))});
    const { ScopeContext } = await import(${JSON.stringify(path.join(harness, "scope/context.ts"))});
    const { SessionPreparingError } = await import(${JSON.stringify(path.join(harness, "storage/errors.ts"))});
    await using handle = await StorageMaintenance.open();
    if (handle.manifest.phase !== "active") throw new Error("Global authority did not activate");
    if ((await SessionCompat.stats()).pending !== ${held ? 2 : 1}) throw new Error("Release upgrade imported cold or held history");
    const folders = await handle.store.read(["project_directories", ${JSON.stringify(projectID)}]);
    if (folders?.version !== 1 || !folders.mainWorkspaceID || folders.additionalWorkspaceIDs.length !== 1)
      throw new Error("Project folders were not migrated before admission");
    const mainFolder = await handle.store.read(["workspace", folders.mainWorkspaceID]);
    const additionalFolder = await handle.store.read(["workspace", folders.additionalWorkspaceIDs[0]]);
    if (mainFolder.binding.path !== ${JSON.stringify(main.path)} || additionalFolder.binding.path !== ${JSON.stringify(additional.path)})
      throw new Error("Project folder locations changed");
    if (!mainFolder.sharedWritableWorkspaceIDs.includes(additionalFolder.id))
      throw new Error("Additional project folder access was not migrated");
    if (${held}) {
      const loop = await handle.store.read(["blueprint_loops", "home", ${JSON.stringify(loopID)}]);
      if (loop.status !== "running") throw new Error("Held loop was not migrated at startup");
    }
    await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ title: "New work" }) });
    if ((await SessionCompat.stats()).pending !== ${held ? 2 : 1}) throw new Error("Creating new work imported unrelated history");
    try {
      await SessionCompat.requireImported(${JSON.stringify(fixture.records[0].value.id)});
    } catch (error) {
      if (!(error instanceof SessionPreparingError)) throw error;
      await SessionCompat.ensureImported(${JSON.stringify(fixture.records[0].value.id)});
    }
    if ((await SessionCompat.stats()).imported !== 1) throw new Error("Requested history did not converge independently");
    const { SessionHistory } = await import(${JSON.stringify(path.join(harness, "session/history.ts"))});
    await SessionHistory.prepareDisplayOwner({ scopeID: "home", sessionID: ${JSON.stringify(fixture.records[0].value.id)} });
    const display = await handle.store.read(["sessions", "home", ${JSON.stringify(fixture.records[0].value.id)}, "display_state"]);
    if (!display.ready || display.count !== 1) throw new Error("Published history display index is incomplete");
    if (${held}) {
      await SessionCompat.ensureImported(${JSON.stringify(heldSessionID)});
      const info = await handle.store.read(["sessions", "home", ${JSON.stringify(heldSessionID)}, "info"]);
      if (info.blueprint.phase !== "running" || info.blueprint.loopID !== ${JSON.stringify(loopID)} || info.paused?.reason !== "workflow")
        throw new Error("Deferred import did not preserve the workflow hold");
      if ((await SessionCompat.stats()).pending !== 0) throw new Error("Selected held history did not converge");
    }
    if ((await handle.store.verify()).issues.length) throw new Error("Store verification failed");
    });
  `
    const env: NodeJS.ProcessEnv = { ...process.env, SYNERGY_HOME: tmp.path }
    delete env.SYNERGY_STORAGE_COMPAT_DEFER
    const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code, stderr).toBe(0)
  }, 30_000)
}
