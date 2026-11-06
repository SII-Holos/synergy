import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function verify(input: { export?: string; linked?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-installed-boundary-"))
  try {
    const install = path.join(root, "install")
    const packagePath = path.join(install, "node_modules/@ericsanchezok/synergy-harness")
    const source = input.linked ? path.join(root, "outside-package") : packagePath
    await fs.mkdir(source, { recursive: true })
    const exports = Object.fromEntries(
      [
        "lifecycle",
        "session",
        "tools",
        "context",
        "config",
        "persistence",
        "scope",
        "rollout",
        ...(input.export ? [input.export] : []),
      ].map((entry) => [`./${entry}`, "./index.js"]),
    )
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-harness", type: "module", exports }),
    )
    await Bun.write(path.join(source, "index.js"), "export const contract = true")
    if (input.linked) {
      await fs.mkdir(path.dirname(packagePath), { recursive: true })
      await fs.symlink(source, packagePath, "dir")
    }
    const fixture = await Bun.file(path.resolve(import.meta.dir, "../package/fixture/package-boundary.ts")).text()
    await Bun.write(path.join(install, "check.ts"), `${fixture}\nawait assertInstalledPackageBoundaries()`)
    const child = Bun.spawn([process.execPath, "check.ts"], {
      cwd: install,
      env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("installed boundary accepts explicit public entries from an isolated package", async () => {
  const result = await verify()
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ publicEntries: 8, privateExportsRejected: true })
})

test("installed boundary rejects a formerly private processor export", async () => {
  const result = await verify({ export: "session/processor" })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Private core entry is publicly resolvable: session/processor")
})

test("installed boundary rejects a workspace link escaping the installation", async () => {
  const result = await verify({ linked: true })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Workspace linked outside installation")
})
