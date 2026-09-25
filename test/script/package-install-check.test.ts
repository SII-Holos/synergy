import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withInstalledPackages, type PackedArchive } from "../../script/package-install-check"

test("installed package fixtures retain their registry from a nested installer directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-registry-isolation-"))
  let ambientRequests = 0
  const ambient = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      ambientRequests++
      return new Response("Fixture escaped its registry", { status: 404 })
    },
  })
  try {
    const config = `@ericsanchezok:registry=http://127.0.0.1:${ambient.port}\n`
    const ambientConfig = path.join(root, "ambient-config", ".npmrc")
    await Bun.write(ambientConfig, config)
    const ambientEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.dirname(ambientConfig) }
    const archives: PackedArchive[] = []
    for (const suffix of ["core", "component"]) {
      const manifest = { name: `@ericsanchezok/synergy-registry-${suffix}-${crypto.randomUUID()}`, version: "1.0.0" }
      const archive = path.join(root, `${suffix}.tgz`)
      await Bun.write(
        archive,
        Bun.gzipSync(await new Bun.Archive({ "package/package.json": JSON.stringify(manifest) }).bytes()),
      )
      archives.push({ ...manifest, manifest, archive })
    }
    await withInstalledPackages(
      archives,
      [archives[0].name],
      async (directory, env) => {
        const nested = path.join(directory, "home/.synergy/installations/staging")
        await Bun.write(path.join(nested, "package.json"), JSON.stringify({ private: true }))
        const child = Bun.spawn([process.execPath, "add", "--ignore-scripts", archives[1].name], {
          cwd: nested,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stderr + stdout).toBe(0)
        expect(await Bun.file(path.join(nested, "node_modules", archives[1].name, "package.json")).json()).toEqual(
          archives[1].manifest,
        )
      },
      { env: ambientEnv },
    )
    expect(ambientRequests).toBe(0)
    expect(await Bun.file(ambientConfig).text()).toBe(config)
  } finally {
    ambient.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
