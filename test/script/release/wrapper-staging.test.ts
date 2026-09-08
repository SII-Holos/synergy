import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stageSynergyWrapper } from "../../../script/release/nodes/prepare-synergy-packages"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test("wrapper staging uses the CLI's complete bin directory and keeps the public full-product brand", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-wrapper-staging-"))
  directories.push(root)
  const cliDir = path.join(root, "cli")
  await fs.mkdir(path.join(cliDir, "bin"), { recursive: true })
  await fs.mkdir(path.join(cliDir, "script"))
  await fs.writeFile(path.join(cliDir, "bin/synergy"), "executable")
  await fs.writeFile(path.join(cliDir, "bin/platform-package.cjs"), "resolver")
  await fs.writeFile(path.join(cliDir, "script/postinstall.mjs"), "installer")
  const options = {
    cliDir,
    runtimeDistDir: path.join(root, "full-dist"),
    version: "1.2.3",
    optionalDependencies: { "@ericsanchezok/synergy-darwin-arm64": "1.2.3" },
    repositoryUrl: "https://github.com/SII-Holos/synergy.git",
  }
  const output = await stageSynergyWrapper(options)
  expect(path.basename(output)).toBe("synergy")
  const manifest = await Bun.file(path.join(output, "package.json")).json()
  expect(manifest.name).toBe("@ericsanchezok/synergy")
  expect(manifest.bin).toEqual({ synergy: "./bin/synergy" })
  expect(manifest.optionalDependencies).toEqual(options.optionalDependencies)
  expect(await Bun.file(path.join(output, "bin/platform-package.cjs")).text()).toBe("resolver")
  expect(await Bun.file(path.join(output, "postinstall.mjs")).text()).toBe("installer")
  await fs.writeFile(path.join(output, "bin/stale"), "stale")
  await stageSynergyWrapper(options)
  expect((await fs.readdir(path.join(output, "bin"))).sort()).toEqual(["platform-package.cjs", "synergy"])
})
