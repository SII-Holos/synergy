import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

export async function assertInstalledPackageBoundaries() {
  assert.equal(process.env.NODE_PATH, undefined)
  assert.equal(process.env.NODE_OPTIONS, undefined)
  const root = await fs.realpath(process.cwd())
  const directory = path.join(root, "node_modules", "@ericsanchezok")
  const closure = []
  for (const name of await fs.readdir(directory)) {
    const installed = await fs.realpath(path.join(directory, name))
    assert.ok(installed.startsWith(root + path.sep), `Workspace linked outside installation: ${name}`)
    const manifest = await Bun.file(path.join(installed, "package.json")).json()
    closure.push(manifest.name)
    if (!manifest.name.startsWith("@ericsanchezok/synergy-")) continue
    for (const key of Object.keys(manifest.exports ?? {})) {
      assert.ok(
        !key.startsWith("./test/") && !key.startsWith("./script/"),
        `Private export shipped: ${manifest.name}${key.slice(1)}`,
      )
    }
  }
  for (const entry of ["lifecycle", "session", "tools", "context", "config", "persistence", "scope", "rollout"]) {
    const resolved = import.meta.resolve(`@ericsanchezok/synergy-harness/${entry}`)
    assert.ok(resolved.includes("node_modules/"), `Core public entry escaped installed packages: ${entry}`)
    assert.ok(Object.keys(await import(`@ericsanchezok/synergy-harness/${entry}`)).length > 0)
  }
  for (const entry of [
    "session/processor",
    "session/resolver",
    "session/tool-resolver",
    "session/tool-scheduler",
    "session/journal",
    "session/rollout/journal",
    "test/internal/session/processor",
    "test/internal/session/resolver",
    "test/internal/session/tool-resolver",
    "test/internal/session/tool-scheduler",
    "test/internal/session/rollout/journal",
    "test/support/fixture",
    "test/support/internals",
  ]) {
    assert.throws(
      () => import.meta.resolve(`@ericsanchezok/synergy-harness/${entry}`),
      `Private core entry is publicly resolvable: ${entry}`,
    )
  }
  console.log(JSON.stringify({ installedClosure: closure.toSorted(), publicEntries: 8, privateExportsRejected: true }))
}
