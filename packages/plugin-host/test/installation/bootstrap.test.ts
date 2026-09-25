import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareInstalledLaunch } from "../../src/installation/bootstrap"
import { InstallationGenerations } from "../../src/installation/generations"
import { seedInstalledCore } from "../../src/installation/seed"

const name = (id: string) => `@ericsanchezok/synergy-${id}`

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bootstrap-"))
  async function release(version: string) {
    const modules = path.join(directory, version, "node_modules")
    const write = (id: string, data: object) =>
      Bun.write(path.join(modules, name(id), "package.json"), JSON.stringify({ name: name(id), version, ...data }))
    await write("cli", { dependencies: { [name("harness")]: version } })
    await write("harness", { exports: { "./lifecycle": "./index.js" } })
    await Bun.write(path.join(modules, name("harness"), "index.js"), 'throw new Error("No bootstrap imports")')
    for (const id of ["mcp", "web"])
      await write(id, {
        synergy: { formatVersion: 1, kind: "preset", id, version, compatibility: { synergy: version }, packages: {} },
      })
    return path.join(modules, name("cli"))
  }
  return {
    directory,
    root: path.join(directory, "home"),
    release,
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

test("upgrading the launcher replaces the core, preserves explicit selection and old worker pins", async () => {
  await using temp = await fixture()
  const first = await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0", {
    roots: { [name("mcp")]: "2.0.0" },
  })
  const upgraded = await prepareInstalledLaunch(temp.root, {
    version: "2.1.0",
    installedCore: await temp.release("2.1.0"),
  })
  expect(upgraded.hostVersion).toBe("2.1.0")
  expect(upgraded.roots).toEqual({ [name("mcp")]: "2.1.0" })
  expect(upgraded.packages[name("cli")].version).toBe("2.1.0")
  expect(
    (
      await prepareInstalledLaunch(temp.root, {
        version: "2.1.0",
        pin: JSON.stringify({ id: first.id, sha256: first.sha256 }),
      })
    ).id,
  ).toBe(first.id)
  await expect(prepareInstalledLaunch(temp.root, { version: "2.0.0" })).rejects.toThrow("requires Synergy 2.1.0")
})

test("an existing core selection remains minimal when a full launcher is installed", async () => {
  await using temp = await fixture()
  await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0")
  const seed = await seedInstalledCore(path.join(temp.directory, "seed"), await temp.release("2.1.0"), "2.1.0", {
    roots: { [name("web")]: "2.1.0" },
  })
  const upgraded = await prepareInstalledLaunch(temp.root, { version: "2.1.0", seed: seed.directory })
  expect(upgraded.hostVersion).toBe("2.1.0")
  expect(upgraded.roots).toEqual({})
  expect(Object.keys(upgraded.packages)).toEqual([name("cli")])
})

test("legacy homes retain the full Web backend without installing another Desktop application", async () => {
  await using temp = await fixture()
  const config = path.join(temp.root, "config/synergy.d/100-general.jsonc")
  await Bun.write(config, '{"oldSetting":true}')
  const generation = await prepareInstalledLaunch(temp.root, {
    version: "2.0.0",
    installedCore: await temp.release("2.0.0"),
  })
  expect(generation.roots).toEqual({ [name("web")]: "2.0.0" })
  expect(generation.packages[name("desktop-app")]).toBeUndefined()
  expect(await Bun.file(config).text()).toBe('{"oldSetting":true}')
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(generation.id)
})

test("a failed upgrade preserves the active installation", async () => {
  await using temp = await fixture()
  const first = await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0")
  await expect(
    prepareInstalledLaunch(temp.root, { version: "2.1.0", installedCore: path.join(temp.directory, "missing") }),
  ).rejects.toThrow()
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(first.id)
})

test("pending plugin activation can resume using the old core before a launcher upgrade", async () => {
  await using temp = await fixture()
  const first = await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0")
  const directory = await InstallationGenerations.stage(temp.root)
  await fs.cp(first.directory, directory, {
    recursive: true,
    filter: (filename) => filename !== path.join(first.directory, "generation.json"),
  })
  await Bun.write(
    path.join(directory, "plugin-activation.json"),
    JSON.stringify({ version: 1, installs: [], removes: [] }),
  )
  const pending = await InstallationGenerations.commit(temp.root, {
    ...first,
    directory,
    previous: first.id,
    trustHostCode: true,
  })
  const options = { version: "2.1.0", installedCore: await temp.release("2.1.0") }
  await expect(prepareInstalledLaunch(temp.root, options)).rejects.toThrow("pending plugin activation")
  expect((await prepareInstalledLaunch(temp.root, { ...options, resume: true })).id).toBe(pending.id)
  await Bun.write(path.join(temp.root, "installations/activated", pending.id + ".json"), JSON.stringify(pending.sha256))
  expect((await prepareInstalledLaunch(temp.root, options)).hostVersion).toBe("2.1.0")
})
