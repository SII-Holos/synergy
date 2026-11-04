import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertNpmArchiveSize, NPM_ARCHIVE_BUDGET } from "../../../script/release/shared/publish-modules"
import { packPublicationDirectory } from "../../../script/release/shared/publish-generic"
import { prepareSynergyCandidate } from "../../../script/release/nodes/publish-synergy-candidate"
import { requiredRuntimeArtifactPaths, writeRuntimeManifest } from "../../../script/release/shared/runtime-contract"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-publication-archives-"))
  directories.push(directory)
  return directory
}

test("publication rejects a missing or oversized archive before registry access", async () => {
  const directory = await fixture()
  const pkg = { name: "@ericsanchezok/synergy-linux-x64", archive: path.join(directory, "package.tgz") }
  await expect(assertNpmArchiveSize(pkg)).rejects.toThrow("Missing publication archive")
  await Bun.write(pkg.archive, "")
  await fs.truncate(pkg.archive, NPM_ARCHIVE_BUDGET)
  await assertNpmArchiveSize(pkg)
  await fs.truncate(pkg.archive, NPM_ARCHIVE_BUDGET + 1)
  await expect(assertNpmArchiveSize(pkg)).rejects.toThrow("exceeds")
})

test("platform publication prepares every bounded archive and preserves its executable and runtime files", async () => {
  const directory = await fixture()
  await fs.mkdir(path.join(directory, "modules-packages"))
  const platform = "synergy-linux-x64"
  for (const name of [platform, "synergy"])
    await Bun.write(
      path.join(directory, name, "package.json"),
      JSON.stringify({ name: `@ericsanchezok/${name}`, version: "3.1.0" }),
    )
  for (const file of requiredRuntimeArtifactPaths(platform)) await Bun.write(path.join(directory, platform, file), file)
  const executable = path.join(directory, platform, "bin/synergy")
  await Bun.write(executable, "#!/bin/sh\nexit 0\n")
  await fs.chmod(executable, 0o755)
  await Bun.write(path.join(directory, platform, "runtime/node_modules/dependency/data.wasm"), "runtime payload")
  await writeRuntimeManifest(path.join(directory, platform), platform)
  const candidate = await prepareSynergyCandidate("3.1.0", directory)
  expect(candidate.platformNames).toEqual([platform])
  expect(candidate.archives.map((pkg) => pkg.name)).toEqual([`@ericsanchezok/${platform}`, "@ericsanchezok/synergy"])
  const extract = path.join(directory, "extracted")
  await fs.mkdir(extract)
  const process = Bun.spawn(["tar", "-xzf", candidate.archives[0]!.archive, "-C", extract])
  expect(await process.exited).toBe(0)
  expect(await Bun.file(path.join(extract, "package/runtime/node_modules/dependency/data.wasm")).text()).toBe(
    "runtime payload",
  )
  expect((await fs.stat(path.join(extract, "package/bin/synergy"))).mode & 0o111).toBe(0o111)
  await Bun.write(path.join(directory, platform, "runtime/node_modules/dependency/.npmignore"), "ignored metadata")
  await writeRuntimeManifest(path.join(directory, platform), platform)
  await expect(prepareSynergyCandidate("3.1.0", directory)).rejects.toThrow("runtime manifest file is missing")
})

test("packing rejects an identity that differs from the selected candidate", async () => {
  const directory = await fixture()
  await Bun.write(path.join(directory, "package.json"), JSON.stringify({ name: "other", version: "3.1.0" }))
  await expect(
    packPublicationDirectory({
      dir: directory,
      name: "expected",
      version: "3.1.0",
      archive: path.join(directory, "package.tgz"),
    }),
  ).rejects.toThrow("Publication identity differs")
})

test("candidate preflight rejects stale module archives before publication", async () => {
  const directory = await fixture()
  const source = path.join(directory, "module")
  const modules = path.join(directory, "modules-packages")
  await fs.mkdir(modules)
  await Bun.write(
    path.join(directory, "synergy/package.json"),
    JSON.stringify({ name: "@ericsanchezok/synergy", version: "3.1.0" }),
  )
  await Bun.write(path.join(source, "package.json"), JSON.stringify({ name: "example", version: "3.0.22" }))
  await packPublicationDirectory({
    dir: source,
    name: "example",
    version: "3.0.22",
    archive: path.join(modules, "example.tgz"),
  })
  await expect(prepareSynergyCandidate("3.1.0", directory)).rejects.toThrow("Stale module publication version")
})
