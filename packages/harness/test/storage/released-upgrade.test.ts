import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

for (const version of ["1.2.33", "2.4.4", "3.0.22"])
  for (const deferred of [false, true]) {
    test(
      `upgrades the v${version} JSON writer shape through the actual startup migration runner (deferred=${deferred})`,
      () =>
        runtime.run(async () => {
          await using tmp = await tmpdir()
          const root = path.join(tmp.path, ".synergy")
          const fixture = (await Bun.file(new URL(`./fixtures/v${version}.json`, import.meta.url)).json()) as {
            records: Array<{ key: string[]; value: unknown }>
          }
          for (const record of fixture.records) {
            const file = path.join(root, "data", ...record.key) + ".json"
            await fs.mkdir(path.dirname(file), { recursive: true })
            await Bun.write(file, JSON.stringify(record.value))
          }
          const entry = new URL("../../src/storage/maintenance.ts", import.meta.url).pathname
          const script = `
        import { RuntimeContext } from ${JSON.stringify(new URL("../../src/lifecycle/context.ts", import.meta.url).pathname)}
        import { registerHarness } from ${JSON.stringify(new URL("../../src/lifecycle/register.ts", import.meta.url).pathname)}
        import { StorageMaintenance } from ${JSON.stringify(entry)}
        const home = process.env.SYNERGY_HOME
        await RuntimeContext.create({ home, root: home + "/.synergy", env: process.env }).run(async () => {
          registerHarness()
          await using handle = await StorageMaintenance.open()
          if (handle.manifest.phase !== "active") throw new Error("Upgrade did not activate")
        })
      `
          const child = Bun.spawn([process.execPath, "-e", script], {
            env: { ...process.env, SYNERGY_HOME: tmp.path, SYNERGY_STORAGE_COMPAT_DEFER: deferred ? "1" : "0" },
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stderr, , code] = await Promise.all([
            new Response(child.stderr).text(),
            new Response(child.stdout).text(),
            child.exited,
          ])
          expect(code, stderr).toBe(0)
          const handle = await StorageBootstrap.inspect(root)
          if (!handle) throw new Error("Upgraded dataset is absent")
          try {
            const session = await handle.store.read<{ id: string; futureOwner: { retained: boolean } }>(
              fixture.records[0].key,
            )
            expect(session.futureOwner).toEqual({ retained: true })
            expect(await handle.store.read(fixture.records[3].key)).toMatchObject({
              text: "Keep the original transcript.",
            })
            expect(await handle.store.read(["session_index", session.id])).toMatchObject({ scopeID: "home" })
            expect((await handle.store.verify()).issues).toEqual([])
            expect(await Bun.file(path.join(root, "data", ...fixture.records[0].key) + ".json").exists()).toBe(false)
          } finally {
            await handle.store.close()
          }
        }),
      30000,
    )
  }

afterRuntimeTests(() => runtime.close())
