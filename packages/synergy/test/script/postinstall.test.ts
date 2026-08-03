import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DesktopInstallation } from "../../src/global/desktop-installation"

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

function runDesktopRuntimeCandidate(
  script: string,
  options: { homedir: string; env: NodeJS.ProcessEnv; existing: string[] },
) {
  const command = [
    `import { desktopRuntimeCandidate } from ${JSON.stringify(script)}`,
    `const existing = new Set(${JSON.stringify(options.existing)})`,
    `const candidate = desktopRuntimeCandidate({ platform: "win32", homedir: ${JSON.stringify(options.homedir)}, env: ${JSON.stringify(options.env)}, existsSync: (value) => existing.has(value) })`,
    `process.stdout.write(JSON.stringify(candidate ?? null))`,
  ].join("; ")
  const result = Bun.spawnSync({
    cmd: ["node", "--input-type=module", "--eval", command],
    env: { ...process.env, SYNERGY_POSTINSTALL_LIBRARY_MODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as string | null
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

  test.each(["bun", "node"] as const)("warns under %s when Desktop coexists", async (runtime) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-postinstall-desktop-warning-"))
    temporaryDirectories.push(home)
    const script = await preparePackage(home)
    const desktopPath = "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy"
    const command = [
      'import { warnAboutDesktopInstallation } from "' + script + '"',
      `warnAboutDesktopInstallation({ platform: "darwin", homedir: process.env.SYNERGY_TEST_HOME, env: { PATH: "" }, existsSync: (candidate) => candidate === ${JSON.stringify(desktopPath)} })`,
    ].join("; ")
    const result = Bun.spawnSync({
      cmd: runtime === "node" ? [runtime, "--input-type=module", "--eval", command] : [runtime, "--eval", command],
      env: { ...process.env, SYNERGY_POSTINSTALL_LIBRARY_MODE: "1", SYNERGY_TEST_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`

    expect(result.exitCode).toBe(0)
    expect(output).toContain(`desktop: ${desktopPath}`)
    expect(output).toContain("package-manager installation will continue")
  })

  test("keeps Windows Desktop runtime discovery in parity with the CLI", async () => {
    const packageHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-postinstall-desktop-parity-"))
    temporaryDirectories.push(packageHome)
    const script = await preparePackage(packageHome)
    const home = "C:\\Users\\tester"
    const localAppData = "D:\\LocalAppData"
    const launcherDirectory = "E:\\Synergy\\bin"
    const launcher = path.win32.join(launcherDirectory, "synergy.cmd")
    const launcherRuntime = path.win32.resolve(launcherDirectory, "..", "resources", "synergy", "bin", "synergy.exe")
    const directDirectory = "F:\\Synergy\\resources\\synergy\\bin"
    const directRuntime = path.win32.join(directDirectory, "synergy.exe")
    const standardRuntime = path.win32.join(
      localAppData,
      "Programs",
      "Synergy",
      "resources",
      "synergy",
      "bin",
      "synergy.exe",
    )
    const scenarios = [
      { env: { LOCALAPPDATA: localAppData, Path: "" }, existing: [standardRuntime] },
      { env: { LOCALAPPDATA: localAppData, Path: launcherDirectory }, existing: [launcher, launcherRuntime] },
      { env: { LOCALAPPDATA: localAppData, Path: directDirectory }, existing: [directRuntime] },
    ]

    for (const scenario of scenarios) {
      const existing = new Set(scenario.existing)
      const cliCandidate = await DesktopInstallation.findWindowsRuntimePath(
        {
          platform: "win32",
          execPath: "C:\\package\\synergy.exe",
          realExecPath: "C:\\package\\synergy.exe",
          env: { USERPROFILE: home, ...scenario.env },
        },
        async (candidate) => existing.has(candidate),
      )
      const postinstallCandidate = runDesktopRuntimeCandidate(script, {
        homedir: home,
        env: { USERPROFILE: home, ...scenario.env },
        existing: scenario.existing,
      })

      expect(postinstallCandidate).toBe(cliCandidate)
    }
  })
})
