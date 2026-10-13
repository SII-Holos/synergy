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
    for (const id of [
      "workflows",
      "connections",
      "agenda",
      "light-loop",
      "blueprint",
      "lattice",
      "boss",
      "anima",
      "agenda-blueprint",
      "agenda-light-loop",
      "plugin-agenda",
      "plugin-blueprint",
      "plugin-light-loop",
      "channels",
      "channel-feishu",
      "github",
      "channel-github",
      "holos",
      "channel-clarus",
      "email",
      "boss-feishu",
      "github-agenda",
      "channel-blueprint",
      "channel-light-loop",
      "channel-lattice",
    ]) {
      await Bun.write(path.join(modules, name(id), "component.js"), 'throw new Error("No bootstrap component imports")')
      await write(id, {
        synergy: {
          formatVersion: 1,
          kind: "component",
          id,
          version,
          compatibility: { synergy: version },
          apiVersion: 1,
          entry: "./component.js",
          export: "component",
        },
      })
    }
    await Bun.write(
      path.join(modules, "third-party/package.json"),
      JSON.stringify({
        name: "third-party",
        version: "1.7.0",
        synergy: {
          formatVersion: 1,
          kind: "preset",
          id: "third-party",
          version: "1.7.0",
          compatibility: { synergy: ">=2.0.0" },
          packages: {},
        },
      }),
    )
    return path.join(modules, name("cli"))
  }
  return {
    directory,
    root: path.join(directory, "home"),
    release,
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

test.each(["2.0.0", "2.1.0"])(
  "legacy aggregate roots upgrade to removable leaves while retaining third-party pins and old generations (%s)",
  async (version) => {
    await using temp = await fixture()
    const first = await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0", {
      roots: { [name("workflows")]: "2.0.0", [name("connections")]: "2.0.0", "third-party": "^1.7.0" },
    })
    const options = { version, installedCore: await temp.release(version) }
    const upgraded = await prepareInstalledLaunch(temp.root, options)
    expect(upgraded.roots[name("workflows")]).toBeUndefined()
    expect(upgraded.roots[name("connections")]).toBeUndefined()
    for (const id of [
      "agenda",
      "blueprint",
      "channels",
      "channel-clarus",
      "boss-feishu",
      "github-agenda",
      "channel-blueprint",
      "channel-light-loop",
      "channel-lattice",
    ]) {
      expect(upgraded.roots[name(id)]).toBe(version)
      expect(upgraded.packages[name(id)].metadata?.id).toBe(id)
    }
    expect(upgraded.roots["third-party"]).toBe("^1.7.0")
    expect(upgraded.packages["third-party"].version).toBe("1.7.0")
    expect((await prepareInstalledLaunch(temp.root, options)).id).toBe(upgraded.id)
    expect((await InstallationGenerations.pin(temp.root, { id: first.id, sha256: first.sha256 })).roots).toEqual(
      first.roots,
    )
  },
)

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

test("a fresh aggregate preset selection retains its current declared closure", async () => {
  await using temp = await fixture()
  const cli = await temp.release("2.1.0")
  await Bun.write(
    path.join(cli, "../synergy-workflows/package.json"),
    JSON.stringify({
      name: name("workflows"),
      version: "2.1.0",
      synergy: {
        formatVersion: 1,
        kind: "preset",
        id: "workflows",
        version: "2.1.0",
        compatibility: { synergy: "2.1.0" },
        packages: { [name("agenda")]: "2.1.0" },
      },
    }),
  )
  const seed = await seedInstalledCore(path.join(temp.directory, "seed"), cli, "2.1.0", {
    roots: { [name("workflows")]: "2.1.0" },
  })
  const selected = await prepareInstalledLaunch(temp.root, { version: "2.1.0", seed: seed.directory })
  expect(selected.roots).toEqual({ [name("workflows")]: "2.1.0" })
  expect(selected.packages[name("agenda")]).toBeDefined()
  expect(selected.packages[name("plugin-blueprint")]).toBeUndefined()
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
  expect((await prepareInstalledLaunch(temp.root, { ...options, deferUpgrade: true })).id).toBe(pending.id)
  await Bun.write(path.join(temp.root, "installations/activated", pending.id + ".json"), JSON.stringify(pending.sha256))
  expect((await prepareInstalledLaunch(temp.root, options)).hostVersion).toBe("2.1.0")
})

test("explicit package removal can use the active core before a blocked host upgrade", async () => {
  await using temp = await fixture()
  const current = await seedInstalledCore(temp.root, await temp.release("2.0.0"), "2.0.0", {
    roots: { [name("mcp")]: "2.0.0" },
  })
  const selected = await prepareInstalledLaunch(temp.root, {
    version: "2.1.0",
    installedCore: path.join(temp.directory, "unavailable-upgrade"),
    deferUpgrade: true,
  })
  expect(selected.id).toBe(current.id)
  expect(selected.roots).toEqual(current.roots)
})
