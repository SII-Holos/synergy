import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("the released 3.0.22 completion ledger admits new work before historical import", async () => {
  await using tmp = await tmpdir()
  const fixture = await Bun.file(new URL("../../../harness/test/storage/fixtures/v3.0.22.json", import.meta.url)).json()
  const ledger = await Bun.file(new URL("./fixtures/v3.0.22-migration-ledger.json", import.meta.url)).json()
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
  const registration = new URL("../../src/product-registration.ts", import.meta.url).pathname
  const script = `
    await import(${JSON.stringify(registration)});
    const { StorageMaintenance } = await import(${JSON.stringify(path.join(harness, "storage/maintenance.ts"))});
    const { SessionCompat } = await import(${JSON.stringify(path.join(harness, "session/compat-import.ts"))});
    const { Session } = await import(${JSON.stringify(path.join(harness, "session/index.ts"))});
    const { Scope } = await import(${JSON.stringify(path.join(harness, "scope/index.ts"))});
    const { ScopeContext } = await import(${JSON.stringify(path.join(harness, "scope/context.ts"))});
    await using handle = await StorageMaintenance.open();
    if (handle.manifest.phase !== "active") throw new Error("Global authority did not activate");
    if ((await SessionCompat.stats()).pending !== 1) throw new Error("Release upgrade waited for all history");
    await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ title: "New work" }) });
    if ((await SessionCompat.stats()).pending !== 1) throw new Error("Creating new work imported unrelated history");
    await SessionCompat.requireImported(${JSON.stringify(fixture.records[0].value.id)});
    if ((await SessionCompat.stats()).imported !== 1) throw new Error("Requested history did not converge");
    if ((await handle.store.verify()).issues.length) throw new Error("Store verification failed");
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
