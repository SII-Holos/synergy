import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("CLI bundle installer", () => {
  test("preserves the packaged sandbox helper beside the installed runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-test-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    await Promise.all([
      fs.mkdir(path.join(bundle, "bin"), { recursive: true }),
      fs.mkdir(path.join(bundle, "app"), { recursive: true }),
      fs.mkdir(path.join(bundle, "schema"), { recursive: true }),
      fs.mkdir(path.join(bundle, "sandbox"), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(bundle, "bin", "synergy"), "runtime"),
      fs.writeFile(path.join(bundle, "app", "index.html"), "app"),
      fs.writeFile(path.join(bundle, "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(bundle, "sandbox", "synergy-sandbox-linux"), "helper"),
    ])

    const installScript = path.resolve(import.meta.dir, "..", "..", "install")
    const command =
      'install_script="$1"; bundle="$2"; set --; source "$install_script"; install_bundle_contents "$bundle"; has_complete_bundle'
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", command, "bash", installScript, bundle],
      env: { ...process.env, HOME: home, SYNERGY_INSTALL_LIBRARY_MODE: "1", SYNERGY_INSTALL_PLATFORM: "Linux" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(path.join(home, ".synergy", "sandbox", "synergy-sandbox-linux")).text()).toBe("helper")
  })

  test("does not treat an existing Linux install without its sandbox helper as complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-incomplete-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    await fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true })
    await fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true })
    await fs.writeFile(path.join(home, ".synergy", "app", "index.html"), "app")
    await fs.writeFile(path.join(home, ".synergy", "schema", "config.schema.json"), "{}")

    const installScript = path.resolve(import.meta.dir, "..", "..", "install")
    const command = 'install_script="$1"; set --; source "$install_script"; has_complete_bundle'
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", command, "bash", installScript],
      env: { ...process.env, HOME: home, SYNERGY_INSTALL_LIBRARY_MODE: "1", SYNERGY_INSTALL_PLATFORM: "Linux" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).not.toBe(0)
  })
})
