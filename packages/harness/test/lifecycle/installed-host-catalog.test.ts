import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("an installed source host opens and closes without loading the bundled catalog", async () => {
  const fixture = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "installed-host-"))
  const owner = path.resolve(import.meta.dir, "../..")
  const modules = path.join(fixture, "node_modules")
  const installed = path.join(modules, "@ericsanchezok/synergy-harness")
  try {
    await fs.mkdir(installed, { recursive: true })
    await fs.cp(path.join(owner, "src"), path.join(installed, "src"), { recursive: true })
    await fs.copyFile(path.join(owner, "package.json"), path.join(installed, "package.json"))
    await fs.mkdir(path.join(installed, "script"))
    await fs.copyFile(path.join(owner, "script/build-sqlite.ts"), path.join(installed, "script/build-sqlite.ts"))
    for (const entry of await fs.readdir(path.join(owner, "node_modules"), { withFileTypes: true })) {
      if (entry.name === "@ericsanchezok") {
        for (const name of await fs.readdir(path.join(owner, "node_modules", entry.name))) {
          if (name === "synergy-harness") continue
          await fs.symlink(path.join(owner, "node_modules", entry.name, name), path.join(modules, entry.name, name))
        }
      } else await fs.symlink(path.join(owner, "node_modules", entry.name), path.join(modules, entry.name))
    }
    await Bun.write(
      path.join(fixture, "host.ts"),
      `import assert from "node:assert/strict"
import path from "node:path"
import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { ProviderCatalogSource } from "@ericsanchezok/synergy-harness/provider/catalog-source"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
globalThis.fetch = () => { throw new Error("Host catalog must not fetch a product catalog") }
const home = path.join(process.cwd(), "home")
const root = path.join(home, ".synergy")
const runtime = await RuntimeHandle.open({
  host: { home, root, env: { ...process.env, HOME: home, SYNERGY_TEST_HOME: home } },
  composition: { register() { ProviderCatalogSource.register({ providers: async () => ({}) }) } },
  mode: "oneshot",
  storage: { kind: "owned", async open() {
    const store = await TransactionalStore.open({ backend: "sqlite", filename: path.join(root, "authority.sqlite"), namespace: "fixture" })
    return { handle: { store, artifactDirectory: path.join(root, "data") }, needsValidation: false, async activate() {} }
  } },
})
try {
  await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn: async () => assert.deepEqual(await Provider.list(), {}) }))
} finally { await runtime.close() }
assert.equal(runtime.status, "closed")
console.log("installed-host-closed")
`,
    )
    const child = Bun.spawn([process.execPath, "host.ts"], {
      cwd: fixture,
      env: { ...process.env, MODELS_DEV_API_JSON: undefined },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "installed-host-closed\n", stderr: "" })
    } finally {
      child.kill()
      await child.exited
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
