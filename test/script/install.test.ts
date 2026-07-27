import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const installScript = path.resolve(import.meta.dir, "..", "..", "install")

const temporaryDirectories: string[] = []

function runInstallFunction(command: string, args: string[] = [], env: Record<string, string> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "synergy-install-function-"))
  temporaryDirectories.push(home)
  const sourceCommand = [
    'install_script="$1"',
    "shift",
    'function_args=("$@")',
    "set --",
    'source "$install_script"',
    'if [ "${#function_args[@]}" -gt 0 ]; then set -- "${function_args[@]}"; else set --; fi',
  ].join("; ")
  return Bun.spawnSync({
    cmd: ["bash", "-c", `${sourceCommand}; ${command}`, "bash", installScript, ...args],
    env: { ...process.env, HOME: home, SYNERGY_INSTALL_LIBRARY_MODE: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function outputText(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout.toString()}${result.stderr.toString()}`.replace(/\u001B\[[0-9;]*m/g, "")
}

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, `#!/usr/bin/env bash\n${content}\n`)
  await fs.chmod(filePath, 0o755)
}

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
      fs.mkdir(path.join(bundle, "browser-runtime", "playwright-core", "lib"), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(bundle, "bin", "synergy"), "runtime"),
      fs.writeFile(path.join(bundle, "app", "index.html"), "app"),
      fs.writeFile(path.join(bundle, "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(bundle, "sandbox", "synergy-sandbox-linux"), "helper"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "package.json"), "{}"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "index.js"), "runtime"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "lib", "coreBundle.js"), "runtime"),
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
    expect(
      await Bun.file(path.join(home, ".synergy", "browser-runtime", "playwright-core", "package.json")).text(),
    ).toBe("{}")
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

describe("CLI installer guidance", () => {
  test("starts Synergy without requiring a project directory", () => {
    const result = runInstallFunction("print_post_install_message")

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("synergy")
    expect(outputText(result)).not.toContain("cd <project>")
  })

  test("checks Bubblewrap when the current Synergy version is already installed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-current-install-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bin = path.join(root, "bin")
    await Promise.all([
      fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "sandbox"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "browser-runtime", "playwright-core", "lib"), { recursive: true }),
      fs.mkdir(bin, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(home, ".synergy", "app", "index.html"), "app"),
      fs.writeFile(path.join(home, ".synergy", "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(home, ".synergy", "sandbox", "synergy-sandbox-linux"), "helper"),
      fs.writeFile(path.join(home, ".synergy", "browser-runtime", "playwright-core", "package.json"), "{}"),
      fs.writeFile(path.join(home, ".synergy", "browser-runtime", "playwright-core", "index.js"), "runtime"),
      fs.writeFile(
        path.join(home, ".synergy", "browser-runtime", "playwright-core", "lib", "coreBundle.js"),
        "runtime",
      ),
      writeExecutable(path.join(bin, "synergy"), 'printf "1.2.3\\n"'),
    ])

    const command = [
      "specific_version=1.2.3",
      'download_and_install() { printf "unexpected-download\\n"; return 1; }',
      'ensure_linux_bubblewrap() { printf "bubblewrap-check-reached\\n"; }',
      "install_synergy",
    ].join("; ")
    const result = runInstallFunction(command, [], {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("already installed")
    expect(outputText(result)).toContain("bubblewrap-check-reached")
    expect(outputText(result)).not.toContain("unexpected-download")
  })

  test("does not treat an install without the Playwright runtime as complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-playwright-incomplete-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    await Promise.all([
      fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "sandbox"), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(home, ".synergy", "app", "index.html"), "app"),
      fs.writeFile(path.join(home, ".synergy", "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(home, ".synergy", "sandbox", "synergy-sandbox-linux"), "helper"),
    ])

    const command = 'install_script="$1"; set --; source "$install_script"; has_complete_bundle'
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", command, "bash", installScript],
      env: { ...process.env, HOME: home, SYNERGY_INSTALL_LIBRARY_MODE: "1", SYNERGY_INSTALL_PLATFORM: "Linux" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).not.toBe(0)
  })

  test.each([
    ["apt-get", "apt-get install -y bubblewrap"],
    ["dnf", "dnf install -y bubblewrap"],
    ["pacman", "pacman -S --noconfirm bubblewrap"],
  ])("selects the %s bubblewrap install command", (manager: string, expected: string) => {
    const result = runInstallFunction('bubblewrap_install_command "$1"', [manager])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe(expected)
  })

  test.each([
    ["non-Linux platforms", "is_linux_install() { return 1; }"],
    ["an existing bwrap command", "is_linux_install() { return 0; }; has_bubblewrap() { return 0; }"],
  ])("skips Bubblewrap setup for %s", (_scenario: string, setup: string) => {
    const result = runInstallFunction(`${setup}; ensure_linux_bubblewrap`)

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).not.toContain("Bubblewrap")
  })

  test("prints an exact bubblewrap command when installation is non-interactive", () => {
    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      'detect_bubblewrap_package_manager() { printf "apt-get\\n"; }',
      "can_prompt_for_bubblewrap_install() { return 1; }",
      "is_root_user() { return 1; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("sudo apt-get install -y bubblewrap")
  })

  test("prints an exact bubblewrap command when interactive installation is declined", () => {
    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      'detect_bubblewrap_package_manager() { printf "apt-get\\n"; }',
      "can_prompt_for_bubblewrap_install() { return 0; }",
      "confirm_bubblewrap_install() { return 1; }",
      "is_root_user() { return 1; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("sudo apt-get install -y bubblewrap")
  })

  test("installs bubblewrap after interactive confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bwrap-install-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    const log = path.join(root, "sudo.log")
    await fs.mkdir(bin, { recursive: true })
    await writeExecutable(path.join(bin, "sudo"), 'printf "%s\\n" "$*" > "$SYNERGY_TEST_SUDO_LOG"')

    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      'detect_bubblewrap_package_manager() { printf "apt-get\\n"; }',
      "can_prompt_for_bubblewrap_install() { return 0; }",
      "confirm_bubblewrap_install() { return 0; }",
      "is_root_user() { return 1; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command, [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SYNERGY_TEST_SUDO_LOG: log,
    })

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(log).text()).toBe("apt-get install -y bubblewrap\n")
    expect(outputText(result)).toContain("Bubblewrap installed successfully")
    expect(outputText(result)).not.toContain("Run this command manually")
  })

  test("installs bubblewrap directly when already running as root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bwrap-root-install-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    const log = path.join(root, "apt-get.log")
    await fs.mkdir(bin, { recursive: true })
    await writeExecutable(path.join(bin, "apt-get"), 'printf "%s\\n" "$*" > "$SYNERGY_TEST_APT_LOG"')
    await writeExecutable(path.join(bin, "sudo"), 'printf "unexpected sudo" >&2; exit 99')

    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      'detect_bubblewrap_package_manager() { printf "apt-get\\n"; }',
      "can_prompt_for_bubblewrap_install() { return 0; }",
      "confirm_bubblewrap_install() { return 0; }",
      "is_root_user() { return 0; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command, [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SYNERGY_TEST_APT_LOG: log,
    })

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(log).text()).toBe("install -y bubblewrap\n")
    expect(outputText(result)).not.toContain("unexpected sudo")
  })

  test("keeps Synergy installed when bubblewrap installation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bwrap-failure-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    await fs.mkdir(bin, { recursive: true })
    await writeExecutable(path.join(bin, "sudo"), "exit 17")

    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      'detect_bubblewrap_package_manager() { printf "apt-get\\n"; }',
      "can_prompt_for_bubblewrap_install() { return 0; }",
      "confirm_bubblewrap_install() { return 0; }",
      "is_root_user() { return 1; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command, [], { PATH: `${bin}:${process.env.PATH ?? ""}` })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("Automatic Bubblewrap installation failed")
    expect(outputText(result)).toContain("Run this command manually: sudo apt-get install -y bubblewrap")
  })

  test("falls back to package-manager guidance when no supported manager is available", () => {
    const command = [
      "is_linux_install() { return 0; }",
      "has_bubblewrap() { return 1; }",
      "detect_bubblewrap_package_manager() { return 1; }",
      "ensure_linux_bubblewrap",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("install Bubblewrap with your system package manager")
  })
})
