import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const postinstallSource = path.resolve(import.meta.dir, "..", "..", "script", "postinstall.mjs")
const platformPackageSource = path.resolve(import.meta.dir, "..", "..", "bin", "platform-package.cjs")
const temporaryDirectories: string[] = []

async function preparePackage(root: string) {
  const packageRoot = path.join(root, "package")
  const binRoot = path.join(packageRoot, "bin")
  await fs.mkdir(binRoot, { recursive: true })
  await Promise.all([
    fs.copyFile(postinstallSource, path.join(packageRoot, "postinstall.mjs")),
    fs.copyFile(platformPackageSource, path.join(binRoot, "platform-package.cjs")),
  ])
  return path.join(packageRoot, "postinstall.mjs")
}

function runWarning(runtime: "bun" | "node", script: string, home: string, searchPath: string) {
  const command = [
    'import { warnAboutStandaloneInstallation } from "' + script + '"',
    'warnAboutStandaloneInstallation({ homedir: process.env.SYNERGY_TEST_HOME, platform: "linux", env: { PATH: process.env.SYNERGY_TEST_PATH } })',
  ].join("; ")
  return Bun.spawnSync({
    cmd: runtime === "node" ? [runtime, "--input-type=module", "--eval", command] : [runtime, "--eval", command],
    env: {
      ...process.env,
      SYNERGY_POSTINSTALL_LIBRARY_MODE: "1",
      SYNERGY_TEST_HOME: home,
      SYNERGY_TEST_PATH: searchPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("package postinstall channel warnings", () => {
  test.each(["bun", "node"] as const)("warns under %s without failing package setup", async (runtime) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-postinstall-warning-"))
    temporaryDirectories.push(home)
    const script = await preparePackage(home)
    const standaloneBin = path.join(home, ".synergy", "bin")
    await fs.mkdir(standaloneBin, { recursive: true })
    await fs.writeFile(path.join(standaloneBin, "synergy"), "standalone")

    const result = runWarning(runtime, script, home, standaloneBin)
    const output = `${result.stdout.toString()}${result.stderr.toString()}`

    expect(result.exitCode).toBe(0)
    expect(output).toContain("another Synergy installation channel is already present")
    expect(output).toContain(`standalone: ${path.join(standaloneBin, "synergy")}`)
    expect(output).toContain("package-manager installation will continue")
    expect(output).toContain("--installation-only --method standalone")
  })

  test("does not warn when no standalone runtime exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-postinstall-single-channel-"))
    temporaryDirectories.push(home)
    const script = await preparePackage(home)

    const result = runWarning("node", script, home, "")

    expect(result.exitCode).toBe(0)
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toBe("")
  })
})
