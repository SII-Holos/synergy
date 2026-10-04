import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withInstalledPackages, type PackedArchive } from "../../script/package-install-check"

test("shared download cache preserves fresh installations and current same-version archive bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-install-cache-"))
  const cache = path.join(root, "downloads")
  const dependency = { name: `download-${crypto.randomUUID()}`, version: "1.0.0" }
  const downloaded = Bun.gzipSync(await new Bun.Archive({ "package/package.json": JSON.stringify(dependency) }).bytes())
  let requests = 0
  using registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith(".tgz")) {
        requests++
        return new Response(downloaded)
      }
      return Response.json({
        name: dependency.name,
        "dist-tags": { latest: dependency.version },
        versions: {
          [dependency.version]: {
            ...dependency,
            dist: { tarball: new URL("dependency.tgz", request.url).toString() },
          },
        },
      })
    },
  })
  const manifest = {
    name: `@ericsanchezok/synergy-cache-${crypto.randomUUID()}`,
    version: "1.0.0",
    dependencies: { [dependency.name]: dependency.version },
  }
  const archive = path.join(root, "package.tgz")
  const directories: string[] = []
  const caches: string[] = []
  try {
    for (const value of ["first", "first", "second"]) {
      await Bun.write(
        archive,
        Bun.gzipSync(
          await new Bun.Archive({
            "package/package.json": JSON.stringify(manifest),
            "package/value.txt": value,
          }).bytes(),
        ),
      )
      await withInstalledPackages(
        [{ ...manifest, manifest, archive }],
        [manifest.name],
        async (directory, env) => {
          expect(env.BUN_INSTALL_CACHE_DIR?.startsWith(cache + path.sep)).toBe(true)
          caches.push(env.BUN_INSTALL_CACHE_DIR!)
          if (caches.length === 2) expect(caches[1]).toBe(caches[0])
          expect(directories).not.toContain(directory)
          directories.push(directory)
          expect(await Bun.file(path.join(directory, "home", "sentinel")).exists()).toBe(false)
          const packageRoot = path.join(directory, "node_modules", manifest.name)
          expect(await Bun.file(path.join(packageRoot, "value.txt")).text()).toBe(value)
          expect(await Bun.file(path.join(directory, "node_modules", dependency.name, "package.json")).json()).toEqual(
            dependency,
          )
          await Bun.write(path.join(directory, "home", "sentinel"), "previous Home")
        },
        { env: { SYNERGY_TEST_INSTALL_CACHE: cache, npm_config_registry: registry.url.toString() } },
      )
      expect(await Bun.file(path.join(directories.at(-1)!, "package.json")).exists()).toBe(false)
      expect(Array.from(new Bun.Glob("**/*").scanSync({ cwd: cache })).length).toBeGreaterThan(0)
      if (directories.length <= 2) expect(requests).toBe(1)
    }
    expect(caches[1]).toBe(caches[0])
    expect(caches[2]).not.toBe(caches[0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
