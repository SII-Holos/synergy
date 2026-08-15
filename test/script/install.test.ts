import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const installScript = path.resolve(import.meta.dir, "..", "..", "install")

const temporaryDirectories: string[] = []

const sharedRuntimeFiles = [
  "app/index.html",
  "schema/config.schema.json",
  "browser-runtime/playwright-core/package.json",
  "browser-runtime/playwright-core/index.js",
  "browser-runtime/playwright-core/lib/coreBundle.js",
  "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
  "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
  "lib/resvg-wasm/index_bg.wasm",
  "lib/resvg-wasm/LICENSE-MPL-2.0.txt",
  "lib/resvg-wasm/THIRD_PARTY_NOTICES.txt",
  "lib/resvg-wasm/fonts/LICENSE-OFL-1.1.txt",
  "lib/resvg-wasm/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2",
  "lib/resvg-wasm/fonts/noto-sans-sc-latin-400-normal.woff2",
  "lib/holos-cli/index.js",
  "lib/holos-cli/vendor/clarus-shared/index.js",
  "lib/holos-cli/node_modules/ws/package.json",
  "lib/holos-cli/node_modules/zod/package.json",
  "watcher.node",
]

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

async function writeRuntimeManifest(root: string, files: string[]) {
  const lines = await Promise.all(
    files.map(async (relative) => {
      const data = await fs.readFile(path.join(root, relative))
      return `${createHash("sha256").update(data).digest("hex")}  ${relative}`
    }),
  )
  await fs.writeFile(path.join(root, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)
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
      fs.mkdir(path.join(bundle, "lib", "onnxruntime-web"), { recursive: true }),
      fs.mkdir(path.join(bundle, "lib", "holos-cli"), { recursive: true }),
      fs.mkdir(path.join(bundle, "lib", "resvg-wasm", "fonts"), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(bundle, "bin", "synergy"), "runtime"),
      fs.writeFile(path.join(bundle, "bin", ".runtime-metadata"), "metadata"),
      fs.writeFile(path.join(bundle, "app", "index.html"), "app"),
      fs.writeFile(path.join(bundle, "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(bundle, "sandbox", "synergy-sandbox-linux"), "helper"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "package.json"), "{}"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "index.js"), "runtime"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "lib", "coreBundle.js"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.mjs"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "resvg-wasm", "index_bg.wasm"), "wasm"),
      fs.writeFile(path.join(bundle, "lib", "resvg-wasm", "LICENSE-MPL-2.0.txt"), "license"),
      fs.writeFile(path.join(bundle, "lib", "resvg-wasm", "THIRD_PARTY_NOTICES.txt"), "notice"),
      fs.writeFile(path.join(bundle, "lib", "resvg-wasm", "fonts", "LICENSE-OFL-1.1.txt"), "license"),
      fs.writeFile(
        path.join(bundle, "lib", "resvg-wasm", "fonts", "noto-sans-sc-chinese-simplified-400-normal.woff2"),
        "font",
      ),
      fs.writeFile(path.join(bundle, "lib", "resvg-wasm", "fonts", "noto-sans-sc-latin-400-normal.woff2"), "font"),
      fs.writeFile(path.join(bundle, "lib", "holos-cli", "index.js"), "runtime"),
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
    expect(await Bun.file(path.join(home, ".synergy", "bin", ".runtime-metadata")).text()).toBe("metadata")
    expect(
      await Bun.file(path.join(home, ".synergy", "browser-runtime", "playwright-core", "package.json")).text(),
    ).toBe("{}")
    expect(
      await Bun.file(
        path.join(home, ".synergy", "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"),
      ).text(),
    ).toBe("runtime")
    expect(await Bun.file(path.join(home, ".synergy", "lib", "resvg-wasm", "index_bg.wasm")).text()).toBe("wasm")
    expect(
      await Bun.file(
        path.join(home, ".synergy", "lib", "resvg-wasm", "fonts", "noto-sans-sc-chinese-simplified-400-normal.woff2"),
      ).text(),
    ).toBe("font")
  })

  test("installs and verifies a complete local release archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-archive-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const archive = path.join(root, "synergy-linux-x64.tar.gz")
    const extracted = path.join(root, "extracted")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), `${relative}\n`)
    }
    await writeRuntimeManifest(bundle, files)
    const packaged = Bun.spawnSync({ cmd: ["tar", "-czf", archive, "."], cwd: bundle, stderr: "pipe" })
    expect(packaged.exitCode).toBe(0)
    await fs.mkdir(extracted, { recursive: true })
    const unpacked = Bun.spawnSync({ cmd: ["tar", "-xzf", archive, "-C", extracted], stderr: "pipe" })
    expect(unpacked.exitCode).toBe(0)

    const result = runInstallFunction(
      'install_bundle_contents "$1"; has_complete_bundle; verify_runtime_manifest "$ROOT_DIR"',
      [extracted],
      { HOME: home, SYNERGY_INSTALL_PLATFORM: "Linux" },
    )

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(path.join(home, ".synergy", "runtime-manifest.sha256")).exists()).toBe(true)
    expect(
      await Bun.file(path.join(home, ".synergy", "lib", "holos-cli", "vendor", "clarus-shared", "index.js")).text(),
    ).toBe("lib/holos-cli/vendor/clarus-shared/index.js\n")
  })

  test("installs a complete Windows runtime contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-windows-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const files = [
      "bin/synergy.exe",
      "bin/ast-grep.exe",
      "vec0.dll",
      "sandbox/synergy-sandbox-windows.exe",
      ...sharedRuntimeFiles,
    ]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)

    const result = runInstallFunction('install_bundle_contents "$1"; has_complete_bundle', [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Windows_NT",
    })

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(path.join(home, ".synergy", "bin", "synergy.exe")).text()).toBe("bin/synergy.exe")
    expect(await Bun.file(path.join(home, ".synergy", "sandbox", "synergy-sandbox-windows.exe")).exists()).toBe(true)
  })

  test("installs a musl runtime without glibc-only native helpers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-musl-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const installedBin = path.join(home, ".synergy", "bin")
    await fs.mkdir(installedBin, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(installedBin, "ast-grep"), "old-glibc-helper"),
      fs.writeFile(path.join(installedBin, "ast-grep.exe"), "old-windows-helper"),
    ])
    const files = ["bin/synergy", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)

    const result = runInstallFunction('is_musl=true; install_bundle_contents "$1"; has_complete_bundle', [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(path.join(installedBin, "ast-grep")).exists()).toBe(false)
    expect(await Bun.file(path.join(installedBin, "ast-grep.exe")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, ".synergy", "vec0.so")).exists()).toBe(false)
  })

  test.each([
    ["Linux", "bin/ast-grep", "bin/synergy", "sandbox/synergy-sandbox-linux", "vec0.so"],
    ["Linux", "vec0.so", "bin/synergy", "sandbox/synergy-sandbox-linux", "bin/ast-grep"],
    ["Darwin", "bin/ast-grep", "bin/synergy", undefined, "vec0.dylib"],
    ["Darwin", "vec0.dylib", "bin/synergy", undefined, "bin/ast-grep"],
    ["Windows_NT", "bin/ast-grep.exe", "bin/synergy.exe", "sandbox/synergy-sandbox-windows.exe", "vec0.dll"],
    ["Windows_NT", "vec0.dll", "bin/synergy.exe", "sandbox/synergy-sandbox-windows.exe", "bin/ast-grep.exe"],
  ])("rejects a %s runtime manifest missing native helper %s", async (platform, omitted, binary, sandbox, included) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-native-contract-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = [binary, ...(sandbox ? [sandbox] : []), included, ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: platform,
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain(`runtime manifest is missing required entry: ${omitted}`)
  })

  test("installs a historical runtime without ONNX or Holos sidecars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-legacy-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const files = [
      "bin/synergy",
      "sandbox/synergy-sandbox-linux",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
    ]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }

    const result = runInstallFunction('install_bundle_contents "$1"', [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("legacy archive has no runtime manifest")
    expect(await Bun.file(path.join(home, ".synergy", "runtime-manifest.sha256")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, ".synergy", "app", "index.html")).text()).toBe("app/index.html")
    expect(await Bun.file(path.join(home, ".synergy", "lib", "onnxruntime-web")).exists()).toBe(false)
  })

  test.skipIf(process.platform === "win32")("atomically replaces a running Synergy executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-running-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const installed = path.join(home, ".synergy", "bin", "synergy")
    await Promise.all([
      fs.mkdir(path.dirname(installed), { recursive: true }),
      fs.mkdir(path.join(bundle, "bin"), { recursive: true }),
      fs.mkdir(path.join(bundle, "app"), { recursive: true }),
      fs.mkdir(path.join(bundle, "schema"), { recursive: true }),
      fs.mkdir(path.join(bundle, "browser-runtime", "playwright-core", "lib"), { recursive: true }),
      fs.mkdir(path.join(bundle, "lib", "onnxruntime-web"), { recursive: true }),
      fs.mkdir(path.join(bundle, "lib", "holos-cli"), { recursive: true }),
      fs.mkdir(path.join(bundle, "sandbox"), { recursive: true }),
    ])
    await fs.copyFile("/bin/sleep", installed)
    await fs.chmod(installed, 0o755)
    const originalInode = (await fs.stat(installed)).ino
    await Promise.all([
      fs.writeFile(path.join(bundle, "bin", "synergy"), "updated runtime"),
      fs.writeFile(path.join(bundle, "app", "index.html"), "app"),
      fs.writeFile(path.join(bundle, "schema", "config.schema.json"), "{}"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "package.json"), "{}"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "index.js"), "runtime"),
      fs.writeFile(path.join(bundle, "browser-runtime", "playwright-core", "lib", "coreBundle.js"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.mjs"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"), "runtime"),
      fs.writeFile(path.join(bundle, "lib", "holos-cli", "index.js"), "runtime"),
      fs.writeFile(path.join(bundle, "sandbox", "synergy-sandbox-linux"), "helper"),
    ])

    const running = Bun.spawn([installed, "30"], { stdout: "ignore", stderr: "ignore" })
    await Bun.sleep(50)
    try {
      const result = runInstallFunction('install_bundle_contents "$1"', [bundle], {
        HOME: home,
        SYNERGY_INSTALL_PLATFORM: "Linux",
      })

      expect(result.exitCode).toBe(0)
      expect(await Bun.file(installed).text()).toBe("updated runtime")
      expect((await fs.stat(installed)).ino).not.toBe(originalInode)
    } finally {
      running.kill()
      await running.exited
    }
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

  test("does not treat an install without the ONNX Web runtime as complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-onnx-incomplete-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    await Promise.all([
      fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "sandbox"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "browser-runtime", "playwright-core", "lib"), { recursive: true }),
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
    ])

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

  test("does not treat an install missing the ONNX Web module as complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-onnx-module-incomplete-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const runtime = path.join(home, ".synergy")
    const files = [
      "bin/synergy",
      "sandbox/synergy-sandbox-linux",
      ...sharedRuntimeFiles.filter(
        (relative) => relative !== "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      ),
    ]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(runtime, relative)), { recursive: true })
      await fs.writeFile(path.join(runtime, relative), relative)
    }

    const result = runInstallFunction("has_complete_bundle", [], { HOME: home, SYNERGY_INSTALL_PLATFORM: "Linux" })
    expect(result.exitCode).not.toBe(0)
  })

  test("rejects a tampered bundle before replacing an existing installation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-tampered-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const installedApp = path.join(home, ".synergy", "app", "index.html")
    const bundle = path.join(root, "bundle")
    await fs.mkdir(path.dirname(installedApp), { recursive: true })
    await fs.writeFile(installedApp, "old-app")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)
    await fs.writeFile(path.join(bundle, "app", "index.html"), "tampered")

    const result = runInstallFunction('install_bundle_contents "$1"', [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })
    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest checksum mismatch: app/index.html")
    expect(await Bun.file(installedApp).text()).toBe("old-app")
  })

  test("restores the previous runtime when a later install stage fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-rollback-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const installed = path.join(home, ".synergy")
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), `new:${relative}`)
    }
    await fs.mkdir(path.join(installed, "app"), { recursive: true })
    await fs.mkdir(path.join(installed, "lib", "holos-cli"), { recursive: true })
    await fs.writeFile(path.join(installed, "app", "index.html"), "old-app")
    await fs.writeFile(path.join(installed, "lib", "holos-cli", "index.js"), "old-holos")

    const command = 'install_bin_contents() { return 17; }; install_bundle_contents "$1"'
    const result = runInstallFunction(command, [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(await Bun.file(path.join(installed, "app", "index.html")).text()).toBe("old-app")
    expect(await Bun.file(path.join(installed, "lib", "holos-cli", "index.js")).text()).toBe("old-holos")
    expect(await Bun.file(path.join(installed, "runtime-manifest.sha256")).exists()).toBe(false)
  })

  test("keeps the recovery backup when restoring the previous runtime fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-restore-failure-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const installed = path.join(home, ".synergy")
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), `new:${relative}`)
    }
    await fs.mkdir(path.join(installed, "app"), { recursive: true })
    await fs.writeFile(path.join(installed, "app", "index.html"), "old-app")

    const command = [
      "install_bin_contents() { return 17; }",
      "restore_managed_runtime() { return 18; }",
      'install_bundle_contents "$1"',
    ].join("; ")
    const result = runInstallFunction(command, [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    const backupName = (await fs.readdir(home)).find((name) => name.startsWith(".synergy.runtime-backup."))
    expect(backupName).toBeDefined()
    expect(await Bun.file(path.join(home, backupName!, "app", "index.html")).text()).toBe("old-app")
    expect(outputText(result)).toContain("Recovery backup preserved at:")
  })

  test("requires exact manifest entries for every checked runtime file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-contract-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = [
      "bin/synergy",
      "bin/ast-grep",
      "vec0.so",
      "watcher.node",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
      "sandbox/synergy-sandbox-linux",
    ]
    for (const relative of [...files, "shadow/app/index.html"]) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(
      bundle,
      files.filter((relative) => relative !== "app/index.html").concat("shadow/app/index.html"),
    )

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest is missing required entry: app/index.html")
  })

  test.each(["bin/synergy", "sandbox/synergy-sandbox-linux"])(
    "requires %s to be covered by the runtime manifest",
    async (omitted) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-platform-"))
      temporaryDirectories.push(root)
      const bundle = path.join(root, "bundle")
      const files = [
        "bin/synergy",
        "bin/ast-grep",
        "vec0.so",
        "watcher.node",
        "app/index.html",
        "schema/config.schema.json",
        "browser-runtime/playwright-core/package.json",
        "browser-runtime/playwright-core/index.js",
        "browser-runtime/playwright-core/lib/coreBundle.js",
        "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
        "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
        "lib/holos-cli/index.js",
        "lib/holos-cli/vendor/clarus-shared/index.js",
        "lib/holos-cli/node_modules/ws/package.json",
        "lib/holos-cli/node_modules/zod/package.json",
        "sandbox/synergy-sandbox-linux",
      ]
      for (const relative of files) {
        await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
        await fs.writeFile(path.join(bundle, relative), relative)
      }
      await writeRuntimeManifest(
        bundle,
        files.filter((relative) => relative !== omitted),
      )

      const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
        SYNERGY_INSTALL_PLATFORM: "Linux",
      })

      expect(result.exitCode).not.toBe(0)
      expect(outputText(result)).toContain(`runtime manifest is missing required entry: ${omitted}`)
    },
  )

  test("rejects manifest entries with trailing fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-trailing-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = [
      "bin/synergy",
      "bin/ast-grep",
      "vec0.so",
      "sandbox/synergy-sandbox-linux",
      ...sharedRuntimeFiles,
      "extra.txt",
    ]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)
    const manifestPath = path.join(bundle, "runtime-manifest.sha256")
    const manifest = await Bun.file(manifestPath).text()
    await fs.writeFile(manifestPath, manifest.replace("  extra.txt\n", "  extra.txt trailing\n"))

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest contains an invalid entry")
  })

  test("rejects duplicate runtime manifest entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-duplicate-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)
    const duplicate = `${createHash("sha256").update("app/index.html").digest("hex")}  app/index.html\n`
    await fs.appendFile(path.join(bundle, "runtime-manifest.sha256"), duplicate)

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest contains a duplicate entry: app/index.html")
  })

  test("rejects runtime files beneath a symbolic-link directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-symlink-directory-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const externalApp = path.join(root, "external-app")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files.filter((relative) => relative !== "app/index.html")) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await fs.mkdir(externalApp, { recursive: true })
    await fs.writeFile(path.join(externalApp, "index.html"), "app/index.html")
    await fs.symlink(externalApp, path.join(bundle, "app"))
    await writeRuntimeManifest(bundle, files)

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest file is missing or unsafe: app/index.html")
  })

  test("rejects a leading-dot runtime manifest path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-dot-path-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)
    const checksum = createHash("sha256").update("app/index.html").digest("hex")
    await fs.appendFile(path.join(bundle, "runtime-manifest.sha256"), `${checksum}  ./app/index.html\n`)

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest contains an unsafe path: ./app/index.html")
  })

  test("rejects a drive-letter runtime manifest path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-manifest-drive-"))
    temporaryDirectories.push(root)
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await writeRuntimeManifest(bundle, files)
    await fs.appendFile(path.join(bundle, "runtime-manifest.sha256"), `${"0".repeat(64)}  C:/outside-runtime\n`)

    const result = runInstallFunction('verify_runtime_manifest "$1"', [bundle], {
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("runtime manifest contains an unsafe path: C:/outside-runtime")
  })

  test("rejects a legacy bundle containing a symbolic link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-legacy-symlink-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(root, "bundle")
    const files = ["bin/synergy", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true })
      await fs.writeFile(path.join(bundle, relative), relative)
    }
    await fs.symlink(path.join(bundle, "app", "index.html"), path.join(bundle, "lib", "linked-app"))

    const result = runInstallFunction('install_bundle_contents "$1"', [bundle], {
      HOME: home,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Release archive contains symbolic links")
    expect(await Bun.file(path.join(home, ".synergy", "app", "index.html")).exists()).toBe(false)
  })

  test.each(["../escape", "safe/../../escape", "/absolute", "C:/windows", "safe\\windows"])(
    "rejects unsafe archive member path %s",
    (member) => {
      const result = runInstallFunction('archive_member_name_is_safe "$1"', [member])

      expect(result.exitCode).not.toBe(0)
    },
  )

  test.each(["tar", "zip"])("rejects an unsafe %s archive member before extraction", (archiveType) => {
    const command =
      archiveType === "tar"
        ? 'tar() { case "$1" in -tvzf) return 0 ;; -tzf) printf "../escape\\n" ;; esac; }; validate_archive_members archive.tar.gz tar'
        : 'unzip() { case "$1" in -Z) return 0 ;; -Z1) printf "../escape\\n" ;; esac; }; validate_archive_members archive.zip zip'
    const result = runInstallFunction(command)

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Release archive contains an unsafe path: ../escape")
  })

  test("rejects a real zip archive containing a symbolic link before extraction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-linked-zip-"))
    temporaryDirectories.push(root)
    const source = path.join(root, "source")
    const archive = path.join(root, "runtime.zip")
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, "target"), "target")
    await fs.symlink("target", path.join(source, "linked"))
    const packaged = Bun.spawnSync({ cmd: ["zip", "-y", archive, "target", "linked"], cwd: source, stderr: "pipe" })
    expect(packaged.exitCode).toBe(0)

    const result = runInstallFunction('validate_archive_members "$1" zip', [archive])

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Release archive contains a symbolic link")
  })

  test("keeps the progress trace FIFO beside the private archive output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-progress-"))
    temporaryDirectories.push(root)
    const output = path.join(root, "runtime.tar.gz")

    const result = runInstallFunction('progress_trace_file "$1"', [output])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe(path.join(root, ".synergy-install-progress.trace"))
  })

  test("fails an HTTP archive download without modifying the existing installation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-download-failure-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const installedApp = path.join(home, ".synergy", "app", "index.html")
    await fs.mkdir(path.dirname(installedApp), { recursive: true })
    await fs.writeFile(installedApp, "old-app")

    const command = [
      "curl() { return 22; }",
      'download_archive_standard "https://example.invalid/missing.tar.gz" "$1"',
    ].join("; ")
    const result = runInstallFunction(command, [path.join(root, "archive.tar.gz")], { HOME: home })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Failed to download Synergy release archive")
    expect(await Bun.file(installedApp).text()).toBe("old-app")
  })

  test("fails closed when the CLI checksum request returns a non-404 response", () => {
    const result = runInstallFunction(
      'curl() { printf "500"; }; download_cli_checksums https://example.invalid/checksums.txt "$1"',
      ["/tmp/synergy-checksums-test"],
    )

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("HTTP 500")
  })

  test("treats only a missing CLI checksum asset as a legacy release", () => {
    const result = runInstallFunction(
      'curl() { printf "404"; }; download_cli_checksums https://example.invalid/checksums.txt "$1"',
      ["/tmp/synergy-checksums-test"],
    )

    expect(result.exitCode).toBe(4)
  })

  test("accepts a downloaded archive that matches the published CLI checksum", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-archive-checksum-valid-"))
    temporaryDirectories.push(root)
    const archive = path.join(root, "synergy-linux-x64.tar.gz")
    const checksumManifest = path.join(root, "Synergy-1.2.3-cli-checksums.txt")
    const data = Buffer.from("release archive")
    await fs.writeFile(archive, data)
    await fs.writeFile(
      checksumManifest,
      `${createHash("sha256").update(data).digest("hex")}  ${path.basename(archive)}\n`,
    )

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksumManifest,
      path.basename(archive),
    ])

    expect(result.exitCode).toBe(0)
  })

  test("rejects duplicate entries for a downloaded archive checksum", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-archive-checksum-duplicate-"))
    temporaryDirectories.push(root)
    const archive = path.join(root, "synergy-linux-x64.tar.gz")
    const checksumManifest = path.join(root, "Synergy-1.2.3-cli-checksums.txt")
    const data = Buffer.from("release archive")
    const line = `${createHash("sha256").update(data).digest("hex")}  ${path.basename(archive)}\n`
    await fs.writeFile(archive, data)
    await fs.writeFile(checksumManifest, `${line}${line}`)

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksumManifest,
      path.basename(archive),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("CLI checksum manifest must contain exactly one entry")
  })

  test("rejects a downloaded archive that does not match the published CLI checksum", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-archive-checksum-mismatch-"))
    temporaryDirectories.push(root)
    const archive = path.join(root, "synergy-linux-x64.tar.gz")
    const checksumManifest = path.join(root, "Synergy-1.2.3-cli-checksums.txt")
    await fs.writeFile(archive, "tampered release archive")
    await fs.writeFile(checksumManifest, `${"0".repeat(64)}  ${path.basename(archive)}\n`)

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksumManifest,
      path.basename(archive),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Downloaded Synergy archive checksum mismatch")
  })

  test("rejects a malformed published CLI checksum manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-archive-checksum-invalid-"))
    temporaryDirectories.push(root)
    const archive = path.join(root, "synergy-linux-x64.tar.gz")
    const checksumManifest = path.join(root, "Synergy-1.2.3-cli-checksums.txt")
    await fs.writeFile(archive, "release archive")
    await fs.writeFile(checksumManifest, `${"0".repeat(64)}  nested/${path.basename(archive)}\n`)

    const result = runInstallFunction('verify_downloaded_archive_checksum "$1" "$2" "$3"', [
      archive,
      checksumManifest,
      path.basename(archive),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("CLI checksum manifest contains an invalid entry")
  })

  test("requires a published checksum for a manifest-backed archive", () => {
    const command = [
      'tar() { case "$1" in -tvzf) printf -- "-rw-r--r-- runtime-manifest.sha256\\n" ;; -tzf) printf "runtime-manifest.sha256\\n" ;; esac; }',
      "require_published_checksum_before_extraction archive.tar.gz tar false checksums.txt",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain(
      "Published CLI checksum is unavailable for this manifest-backed Synergy release: checksums.txt",
    )
  })

  test("treats a runtime-manifest directory entry as manifest-backed", () => {
    const command = [
      'tar() { case "$1" in -tvzf) printf -- "drwxr-xr-x runtime-manifest.sha256/\\n" ;; -tzf) printf "runtime-manifest.sha256/\\n" ;; esac; }',
      "require_published_checksum_before_extraction archive.tar.gz tar false checksums.txt",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Published CLI checksum is unavailable")
  })

  test("allows a legacy archive without a published checksum", () => {
    const command = [
      'tar() { case "$1" in -tvzf) printf -- "-rw-r--r-- bin/synergy\\n" ;; -tzf) printf "bin/synergy\\n" ;; esac; }',
      "require_published_checksum_before_extraction archive.tar.gz tar false checksums.txt",
    ].join("; ")
    const result = runInstallFunction(command)

    expect(result.exitCode).toBe(0)
  })

  test("rejects a manifest-backed archive without a published checksum before extraction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-install-pre-extraction-checksum-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const fakeBin = path.join(root, "bin")
    const tmp = path.join(root, "tmp")
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(fakeBin, { recursive: true }),
      fs.mkdir(tmp, { recursive: true }),
    ])
    await writeExecutable(
      path.join(fakeBin, "uname"),
      'if [ "${1:-}" = "-s" ]; then printf "Linux"; else printf "x86_64"; fi',
    )
    await writeExecutable(
      path.join(fakeBin, "curl"),
      [
        'output=""',
        'previous=""',
        'for argument in "$@"; do',
        '  if [ "$previous" = "-o" ]; then output="$argument"; fi',
        '  previous="$argument"',
        "done",
        'case "${!#}" in *-cli-checksums.txt) printf "404"; exit 0 ;; esac',
        'if [ -n "$output" ]; then mkdir -p "$(dirname "$output")"; printf "archive" > "$output"; fi',
        'case " $* " in *" -w "*) printf "200" ;; esac',
      ].join("\n"),
    )
    await writeExecutable(
      path.join(fakeBin, "tar"),
      [
        'case "$1" in',
        '  -tvzf) printf -- "-rw-r--r-- runtime-manifest.sha256\\n" ;;',
        '  -tzf) printf "runtime-manifest.sha256\\n" ;;',
        '  -xzf) printf "unexpected-extraction\\n" ;;',
        "esac",
      ].join("\n"),
    )
    const packageProbe = path.join(root, "package-probe")
    await writeExecutable(path.join(fakeBin, "npm"), `printf "called" > "${packageProbe}"`)

    const result = Bun.spawnSync({
      cmd: ["bash", installScript, "--version", "1.2.3", "--no-modify-path"],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SHELL: "/bin/bash",
        TMPDIR: tmp,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).not.toBe(0)
    expect(outputText(result)).toContain("Published CLI checksum is unavailable")
    expect(outputText(result)).not.toContain("unexpected-extraction")
    expect(await fs.stat(packageProbe).catch(() => null)).toBeNull()
  })

  test("propagates a download failure without continuing post-install setup", () => {
    const command = [
      "binary_path=",
      "check_version() { return 0; }",
      'download_and_install() { printf "download-failed\\n"; return 42; }',
      'ensure_linux_bubblewrap() { printf "unexpected-bubblewrap\\n"; }',
      "install_synergy",
    ].join("; ")

    const result = runInstallFunction(command)

    expect(result.exitCode).toBe(42)
    expect(outputText(result)).toContain("download-failed")
    expect(outputText(result)).not.toContain("unexpected-bubblewrap")
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
    const bin = path.join(home, ".synergy", "bin")
    await Promise.all([
      fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "sandbox"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "browser-runtime", "playwright-core", "lib"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "lib", "onnxruntime-web"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "lib", "holos-cli"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "lib", "resvg-wasm", "fonts"), { recursive: true }),
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
      fs.writeFile(
        path.join(home, ".synergy", "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"),
        "runtime",
      ),
      fs.writeFile(
        path.join(home, ".synergy", "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.mjs"),
        "runtime",
      ),
      fs.writeFile(path.join(home, ".synergy", "lib", "resvg-wasm", "index_bg.wasm"), "wasm"),
      fs.writeFile(path.join(home, ".synergy", "lib", "resvg-wasm", "LICENSE-MPL-2.0.txt"), "license"),
      fs.writeFile(path.join(home, ".synergy", "lib", "resvg-wasm", "THIRD_PARTY_NOTICES.txt"), "notice"),
      fs.writeFile(path.join(home, ".synergy", "lib", "resvg-wasm", "fonts", "LICENSE-OFL-1.1.txt"), "license"),
      fs.writeFile(
        path.join(home, ".synergy", "lib", "resvg-wasm", "fonts", "noto-sans-sc-chinese-simplified-400-normal.woff2"),
        "font",
      ),
      fs.writeFile(
        path.join(home, ".synergy", "lib", "resvg-wasm", "fonts", "noto-sans-sc-latin-400-normal.woff2"),
        "font",
      ),
      fs.writeFile(path.join(home, ".synergy", "lib", "holos-cli", "index.js"), "runtime"),
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

  test("reinstalls the current version when its runtime manifest no longer verifies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-current-tampered-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    const runtime = path.join(home, ".synergy")
    const bin = path.join(runtime, "bin")
    const files = ["bin/synergy", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux", ...sharedRuntimeFiles]
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(runtime, relative)), { recursive: true })
      await fs.writeFile(path.join(runtime, relative), relative)
    }
    await writeExecutable(path.join(bin, "synergy"), 'printf "1.2.3\\n"')
    await writeRuntimeManifest(runtime, files)
    await fs.writeFile(path.join(runtime, "app", "index.html"), "tampered")

    const command = [
      "specific_version=1.2.3",
      'download_and_install() { printf "download-reached\\n"; }',
      "ensure_linux_bubblewrap() { :; }",
      "install_synergy",
    ].join("; ")
    const result = runInstallFunction(command, [], {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SYNERGY_INSTALL_PLATFORM: "Linux",
    })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("runtime manifest checksum mismatch: app/index.html")
    expect(outputText(result)).toContain("download-reached")
    expect(outputText(result)).not.toContain("already installed")
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

  test("does not treat an install without the SVG raster runtime as complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-svg-raster-incomplete-"))
    temporaryDirectories.push(root)
    const home = path.join(root, "home")
    await Promise.all([
      fs.mkdir(path.join(home, ".synergy", "app"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "schema"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "sandbox"), { recursive: true }),
      fs.mkdir(path.join(home, ".synergy", "browser-runtime", "playwright-core", "lib"), { recursive: true }),
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

  test("warns about package-manager channels without blocking standalone installation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-channel-warning-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    const marker = path.join(root, "continued")
    await fs.mkdir(bin, { recursive: true })
    await writeExecutable(path.join(bin, "npm"), 'printf "%s\\n" "@ericsanchezok/synergy@1.2.3"; exit 0')

    const command = ["warn_about_package_manager_installations", 'printf "continued" > "$1"'].join("; ")
    const result = runInstallFunction(command, [marker], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).toContain("another Synergy installation channel is already present")
    expect(outputText(result)).toContain("npm: 1.2.3")
    expect(outputText(result)).toContain("will continue and will not remove other installations")
    expect(await Bun.file(marker).text()).toBe("continued")
  })

  test("ignores package-manager probe failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-channel-probe-failure-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    await fs.mkdir(bin, { recursive: true })
    await writeExecutable(path.join(bin, "npm"), "exit 17")

    const result = runInstallFunction("warn_about_package_manager_installations", [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    })

    expect(result.exitCode).toBe(0)
    expect(outputText(result)).not.toContain("another Synergy installation channel")
  })
})
