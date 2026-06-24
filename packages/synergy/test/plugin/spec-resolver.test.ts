import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { assertCanonicalPluginIdentity, importUrlForEntry, resolvePluginSpec } from "../../src/plugin/spec-resolver"

async function writePlugin(dir: string, id = "resolver-plugin") {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        main: "./src/index.ts",
        description: "Resolver test plugin",
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: id, version: "0.1.0", type: "module", main: "./src/index.ts" }, null, 2),
  )
  await Bun.write(path.join(dir, "src", "index.ts"), `export default { id: "${id}", async init() { return {} } }\n`)
}

describe("resolvePluginSpec", () => {
  test("resolves file:// directories to canonical plugin manifest and entry", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir) })

    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })

    expect(resolved.source).toBe("local")
    expect(resolved.pkg).toBe("resolver-plugin")
    expect(resolved.version).toBe("0.1.0")
    expect(resolved.pluginDir).toBe(tmp.path)
    expect(resolved.entryPath).toBe(path.join(tmp.path, "src", "index.ts"))
    expect(resolved.manifest?.name).toBe("resolver-plugin")
  })

  test("resolves file:// entry files without losing the package root", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "entry-file-plugin") })
    const entryPath = path.join(tmp.path, "src", "index.ts")

    const resolved = await resolvePluginSpec(pathToFileURL(entryPath).href, { install: false })

    expect(resolved.pluginDir).toBe(tmp.path)
    expect(resolved.entryPath).toBe(entryPath)
    expect(resolved.manifest?.name).toBe("entry-file-plugin")
  })

  test("resolves packed plugin archives as local installable specs", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "archive-plugin") })
    await using archiveTmp = await tmpdir()
    const archivePath = path.join(archiveTmp.path, "archive-plugin-0.1.0.synergy-plugin.tgz")
    const result = Bun.spawnSync(["tar", "-czf", archivePath, "-C", tmp.path, "."])
    expect(result.exitCode).toBe(0)

    const resolved = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })

    expect(resolved.source).toBe("local")
    expect(resolved.pkg).toBe("archive-plugin")
    expect(resolved.manifest?.name).toBe("archive-plugin")
    expect(resolved.entryPath.endsWith(path.join("src", "index.ts"))).toBe(true)
  })
})

describe("assertCanonicalPluginIdentity", () => {
  test("accepts object descriptors whose id matches plugin.json name", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "canonical-plugin") })
    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })
    const mod = await import(importUrlForEntry(resolved.entryPath, Date.now()))

    expect(() =>
      assertCanonicalPluginIdentity({
        manifest: resolved.manifest,
        descriptor: mod.default,
      }),
    ).not.toThrow()
  })

  test("rejects mismatched descriptor id and plugin.json name", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "manifest-id") })
    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })

    expect(() =>
      assertCanonicalPluginIdentity({
        manifest: resolved.manifest,
        descriptor: {
          id: "descriptor-id",
          async init() {
            return {}
          },
        },
      }),
    ).toThrow('plugin.json name "manifest-id" must match PluginDescriptor.id "descriptor-id"')
  })
})
