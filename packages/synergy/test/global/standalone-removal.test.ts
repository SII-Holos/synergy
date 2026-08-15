import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StandaloneInstallation } from "../../src/global/standalone-installation"

describe("standalone installation removal", () => {
  test("removes only installer-managed runtime paths", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-remove-"))
    const root = path.join(home, ".synergy")
    const runtimePaths = [
      "bin/synergy",
      "bin/ast-grep",
      "bin/.runtime-metadata",
      "app/index.html",
      "browser-runtime/playwright-core/index.js",
      "lib/runtime.js",
      "sandbox/synergy-sandbox-linux",
      "schema/config.schema.json",
      "vec0.so",
      "watcher.node",
      "runtime-manifest.sha256",
    ]
    const sharedPaths = ["sandbox-helper/synergy-sandbox-linux", "sandbox-helper/bwrap/bwrap"]
    const dataPaths = ["data/session.json", "config/models.jsonc", "cache/item", "state/server.json", "log/current.log"]

    try {
      for (const relative of [...runtimePaths, ...sharedPaths, ...dataPaths]) {
        const target = path.join(root, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, relative)
      }

      const result = await StandaloneInstallation.remove({ home, platform: "linux" })

      expect(result.removed).toContain(path.join(root, "bin", "synergy"))
      for (const relative of runtimePaths) {
        expect(await fs.stat(path.join(root, relative)).catch(() => null)).toBeNull()
      }
      for (const relative of sharedPaths) {
        expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(relative)
      }
      for (const relative of dataPaths) {
        expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(relative)
      }
      expect(await fs.stat(path.join(root, "bin")).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("removes a managed symlink without touching its target", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-link-"))
    const root = path.join(home, ".synergy")
    const external = path.join(home, "external-runtime")
    const link = path.join(root, "app")

    try {
      await fs.mkdir(root, { recursive: true })
      await fs.mkdir(external, { recursive: true })
      await fs.writeFile(path.join(external, "keep.txt"), "keep")
      await fs.symlink(external, link)

      await StandaloneInstallation.remove({ home, platform: "linux" })

      expect(await fs.lstat(link).catch(() => null)).toBeNull()
      expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("keep")
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects a symbolic-link runtime parent without touching its target", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-parent-link-"))
    const root = path.join(home, ".synergy")
    const external = path.join(home, "external-bin")

    try {
      await fs.mkdir(root, { recursive: true })
      await fs.mkdir(external, { recursive: true })
      await fs.writeFile(path.join(external, "synergy"), "keep")
      await fs.symlink(external, path.join(root, "bin"))

      await expect(StandaloneInstallation.remove({ home, platform: "linux" })).rejects.toThrow(
        "Standalone runtime parent is a symbolic link",
      )
      expect(await fs.readFile(path.join(external, "synergy"), "utf8")).toBe("keep")
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("defers a locked current Windows executable and continues runtime cleanup", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-windows-remove-"))
    const root = path.join(home, ".synergy")
    const executable = path.join(root, "bin", "synergy.exe")
    const astGrep = path.join(root, "bin", "ast-grep.exe")
    const deferred: string[] = []

    try {
      await fs.mkdir(path.dirname(executable), { recursive: true })
      await fs.writeFile(executable, "running")
      await fs.writeFile(astGrep, "helper")

      const result = await StandaloneInstallation.remove({
        home,
        platform: "win32",
        currentExecutable: `\\\\?\\${executable}`,
        dependencies: {
          async remove(target, options) {
            if (target === executable) throw new Error("EPERM")
            await fs.rm(target, options)
          },
          async deferExecutableDeletion(target) {
            deferred.push(target)
            return true
          },
        },
      })

      expect(deferred).toEqual([executable])
      expect(result.deferred).toEqual([executable])
      expect(await fs.stat(astGrep).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("removes a stale deferred Windows executable on the next uninstall", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-windows-pending-"))
    const pending = path.join(home, ".synergy", "bin", "synergy.exe.deleting")

    try {
      await fs.mkdir(path.dirname(pending), { recursive: true })
      await fs.writeFile(pending, "stale")

      const result = await StandaloneInstallation.remove({ home, platform: "win32" })

      expect(result.removed).toContain(pending)
      expect(result.deferred).toEqual([])
      expect(await fs.stat(path.dirname(pending)).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("continues cleanup when deferred Windows executable deletion fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-windows-defer-failure-"))
    const root = path.join(home, ".synergy")
    const executable = path.join(root, "bin", "synergy.exe")
    const astGrep = path.join(root, "bin", "ast-grep.exe")

    try {
      await fs.mkdir(path.dirname(executable), { recursive: true })
      await fs.writeFile(executable, "running")
      await fs.writeFile(astGrep, "helper")

      const removal = StandaloneInstallation.remove({
        home,
        platform: "win32",
        currentExecutable: executable,
        dependencies: {
          async remove(target, options) {
            if (target === executable) throw new Error("EPERM")
            await fs.rm(target, options)
          },
          async deferExecutableDeletion() {
            throw new Error("PowerShell unavailable")
          },
        },
      })

      await expect(removal).rejects.toThrow("PowerShell unavailable")
      expect(await fs.stat(astGrep).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("mirrors the installer's sh shell config candidates", () => {
    expect(StandaloneInstallation.shellConfigFiles({ home: "/home/user", shell: "/bin/sh" })).toEqual([
      "/home/user/.ashrc",
      "/home/user/.profile",
      "/etc/profile",
    ])
  })
  test("removes only standalone PATH entries from shell config", () => {
    const input = [
      "export PATH=/opt/tools/bin:$PATH",
      "# synergy",
      "export PATH=$HOME/.synergy/bin:$PATH",
      "export PATH=/another/.synergy/bin-extra:$PATH",
      "alias synergy-dev='bun dev'",
      "",
    ].join("\n")

    expect(StandaloneInstallation.cleanShellConfigContent(input)).toBe(
      [
        "export PATH=/opt/tools/bin:$PATH",
        "export PATH=/another/.synergy/bin-extra:$PATH",
        "alias synergy-dev='bun dev'",
        "",
      ].join("\n"),
    )
  })

  test("removes the absolute PATH entry written by the installer", () => {
    const home = "/Users/example"
    const input = ["# synergy", `export PATH=${home}/.synergy/bin:$PATH`, "export PATH=/opt/tools/bin:$PATH", ""].join(
      "\n",
    )

    expect(StandaloneInstallation.cleanShellConfigContent(input, home)).toBe(
      ["export PATH=/opt/tools/bin:$PATH", ""].join("\n"),
    )
  })

  test("preserves shell config permissions during atomic cleanup", async () => {
    if (process.platform === "win32") return

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-shell-mode-"))
    const config = path.join(home, ".profile")
    try {
      await fs.writeFile(
        config,
        ["# synergy", "export PATH=$HOME/.synergy/bin:$PATH", "export KEEP=1", ""].join("\n"),
        {
          mode: 0o640,
        },
      )

      await StandaloneInstallation.cleanShellConfig(config, home)

      expect((await fs.stat(config)).mode & 0o777).toBe(0o640)
      expect(await fs.readFile(config, "utf8")).toBe(["export KEEP=1", ""].join("\n"))
      expect((await fs.readdir(home)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("finds and cleans every shell config containing an installer PATH entry", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-shell-configs-"))
    const zshrc = path.join(home, ".zshrc")
    const zshenv = path.join(home, ".zshenv")

    try {
      await fs.writeFile(zshrc, ["# synergy", "export PATH=$HOME/.synergy/bin:$PATH", "alias keep=true", ""].join("\n"))
      await fs.writeFile(
        zshenv,
        ["# synergy", `export PATH=${home}/.synergy/bin:$PATH`, "export KEEP=1", ""].join("\n"),
      )

      const configs = await StandaloneInstallation.findShellConfigs({ home, shell: "/bin/zsh" })
      expect(configs).toEqual([zshrc, zshenv])

      await Promise.all(configs.map((file) => StandaloneInstallation.cleanShellConfig(file, home)))
      expect(await fs.readFile(zshrc, "utf8")).toBe(["alias keep=true", ""].join("\n"))
      expect(await fs.readFile(zshenv, "utf8")).toBe(["export KEEP=1", ""].join("\n"))
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
