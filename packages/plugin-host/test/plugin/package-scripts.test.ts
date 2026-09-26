import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { testRuntime } from "../support/runtime"
import { resolvePluginSpec } from "../../src/plugin/spec-resolver"

test("registry plugin metadata is inspected without executing even default-trusted install scripts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const directory = path.join(Global.Path.cache, "fixture")
    const marker = path.join(Global.Path.cache, "script-ran")
    const pkg = {
      name: "esbuild",
      version: "2.0.0",
      main: "index.js",
      scripts: { postinstall: `${process.execPath} -e 'Bun.write(${JSON.stringify(marker)}, "bad")'` },
    }
    await Bun.write(path.join(directory, "package.json"), JSON.stringify(pkg))
    await Bun.write(path.join(directory, "index.js"), 'throw new Error("metadata inspection must not import code")')
    await Bun.write(
      path.join(directory, "plugin.json"),
      JSON.stringify(
        compilePluginManifest(
          definePlugin({
            id: "script-free-fixture",
            version: "2.0.0",
            description: "installation fixture",
            contributions: [],
          }),
          { generation: "script-free-generation" },
        ),
      ),
    )
    const archive = path.join(Global.Path.cache, "fixture.tgz")
    const pack = Bun.spawn([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], {
      cwd: directory,
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await pack.exited).toBe(0)
    const data = await Bun.file(archive).arrayBuffer()
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith(".tgz")) return new Response(data)
        return Response.json({
          name: pkg.name,
          "dist-tags": { latest: pkg.version },
          versions: {
            [pkg.version]: {
              ...pkg,
              dist: {
                tarball: new URL("/fixture.tgz", request.url).href,
                shasum: createHash("sha1").update(new Uint8Array(data)).digest("hex"),
              },
            },
          },
        })
      },
    })
    try {
      await Bun.write(path.join(Global.Path.cache, ".npmrc"), `registry=${registry.url}\n`)
      const resolved = await resolvePluginSpec("esbuild@2.0.0", { install: true, refresh: true })
      expect(resolved.manifest.id).toBe("script-free-fixture")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await registry.stop(true)
    }
  })
}, 15_000)
