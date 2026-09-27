import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { seedInstalledCore } from "../../src/installation/seed"

test("an offline full seed preserves explicit selections and their declarative component closure", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-full-seed-"))
  const version = "2.0.0"
  try {
    const modules = path.join(temp, "project/node_modules")
    const cli = path.join(modules, "@ericsanchezok/synergy-cli")
    await Bun.write(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "@ericsanchezok/synergy-cli",
        version,
        dependencies: { "@ericsanchezok/synergy-harness": version },
      }),
    )
    await Bun.write(
      path.join(modules, "@ericsanchezok/synergy-harness/package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-harness", version, exports: { "./lifecycle": "./lifecycle.js" } }),
    )
    await Bun.write(path.join(modules, "@ericsanchezok/synergy-harness/lifecycle.js"), "export const identity = {}")
    await Bun.write(
      path.join(modules, "fixture-preset/package.json"),
      JSON.stringify({
        name: "fixture-preset",
        version,
        synergy: {
          formatVersion: 1,
          kind: "preset",
          id: "fixture-preset",
          version,
          compatibility: { synergy: version },
          packages: { "fixture-component": version },
        },
      }),
    )
    await Bun.write(
      path.join(modules, "fixture-component/package.json"),
      JSON.stringify({
        name: "fixture-component",
        version,
        synergy: {
          formatVersion: 1,
          kind: "component",
          id: "fixture-component",
          apiVersion: 1,
          version,
          compatibility: { synergy: version },
          entry: "./index.js",
          export: "component",
        },
      }),
    )
    await Bun.write(
      path.join(modules, "fixture-component/index.js"),
      'throw new Error("seed must not evaluate components")',
    )
    const generation = await seedInstalledCore(path.join(temp, "home/.synergy"), cli, version, {
      roots: { "fixture-preset": version },
    })
    expect(generation.roots).toEqual({ "fixture-preset": version })
    expect(generation.packages["fixture-preset"].dependencies).toEqual({ "fixture-component": version })
    expect(generation.packages["fixture-component"].metadata?.kind).toBe("component")
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test("first launch snapshots only the installed core dependency closure without registry access", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-core-seed-"))
  try {
    const modules = path.join(temp, "project/node_modules")
    const cli = path.join(modules, "@ericsanchezok/synergy-cli")
    const harness = path.join(modules, "@ericsanchezok/synergy-harness")
    await Bun.write(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "@ericsanchezok/synergy-cli",
        version: "2.0.0",
        exports: { "./index": "./index.js" },
        dependencies: { "@ericsanchezok/synergy-harness": "2.0.0", "aliased-module": "npm:actual-module@2.0.0" },
        peerDependencies: { "optional-server": "2.0.0" },
        peerDependenciesMeta: { "optional-server": { optional: true } },
      }),
    )
    await Bun.write(path.join(cli, "index.js"), 'throw new Error("seed copy must not evaluate code")')
    await Bun.write(
      path.join(harness, "package.json"),
      JSON.stringify({
        name: "@ericsanchezok/synergy-harness",
        version: "2.0.0",
        exports: { "./lifecycle": "./lifecycle.js" },
      }),
    )
    await Bun.write(path.join(harness, "lifecycle.js"), "export const identity = {}")
    await Bun.write(path.join(modules, "aliased-module/package.json"), '{"name":"actual-module","version":"2.0.0"}')
    await Bun.write(path.join(modules, "optional-server/package.json"), '{"name":"optional-server","version":"2.0.0"}')
    await Bun.write(path.join(temp, "project/private.txt"), "unrelated project data")
    const generation = await seedInstalledCore(path.join(temp, "home/.synergy"), cli, "2.0.0")
    expect(Object.keys(generation.packages)).toEqual(["@ericsanchezok/synergy-cli"])
    expect(generation.files["node_modules/@ericsanchezok/synergy-harness/lifecycle.js"]?.kind).toBe("file")
    expect(generation.files["node_modules/aliased-module/package.json"]?.kind).toBe("file")
    expect(
      Object.keys(generation.files).some((file) => file.includes("optional-server") || file.includes("private.txt")),
    ).toBe(false)
    await fs.rm(path.join(temp, "project"), { recursive: true })
    expect(
      await Bun.file(path.join(generation.directory, "node_modules/@ericsanchezok/synergy-cli/index.js")).exists(),
    ).toBe(true)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
