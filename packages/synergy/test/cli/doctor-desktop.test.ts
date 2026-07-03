import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DesktopInstallation } from "../../src/global/desktop-installation"

describe("desktop doctor helpers", () => {
  test("reports healthy Desktop CLI links", async () => {
    const status = await DesktopInstallation.inspectCliLink({
      platform: "darwin",
      execPath: "/usr/local/bin/synergy",
      realExecPath: "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
      env: {},
    })

    expect(status.path).toBe("/usr/local/bin/synergy")
    expect(["healthy", "missing", "broken", "conflict"]).toContain(status.status)
  })

  test("detects multiple PATH candidates without executing them", async () => {
    const candidates = await DesktopInstallation.pathCandidates({
      platform: process.platform,
      execPath: process.execPath,
      realExecPath: process.execPath,
      env: { PATH: process.env.PATH ?? "" },
    })

    expect(Array.isArray(candidates)).toBe(true)
  })

  test("marks the Windows Desktop launcher as current without resolving it to the runtime exe", async () => {
    const installRoot = "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy"
    const launcherDir = path.win32.join(installRoot, "bin")
    const launcherPath = path.win32.join(launcherDir, "synergy.cmd")
    const context = {
      platform: "win32" as const,
      execPath: launcherPath,
      realExecPath: path.win32.join(installRoot, "resources", "synergy", "bin", "synergy.exe"),
      env: { Path: `${launcherDir};C:\\Tools` },
    }
    const existing = new Set([DesktopInstallation.normalizePath(launcherPath)])
    const candidates = await DesktopInstallation.pathCandidates(context, {
      async access(candidate) {
        if (!existing.has(DesktopInstallation.normalizePath(candidate))) throw new Error("missing")
      },
      async realpath(candidate) {
        return candidate
      },
    })

    expect(candidates[0]).toEqual({ path: launcherPath, isCurrent: true })
  })

  test("reports matching Desktop package version metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-doctor-version-"))
    const realExecPath = path.join(root, "Synergy.app", "Contents", "Resources", "synergy", "bin", "synergy")
    await fs.mkdir(path.dirname(realExecPath), { recursive: true })
    await fs.writeFile(
      path.join(root, "Synergy.app", "Contents", "Resources", "synergy", "desktop-package.json"),
      '{"version":"1.2.3"}',
    )

    const status = await DesktopInstallation.packageVersionStatus(
      { platform: "darwin", execPath: "/usr/local/bin/synergy", realExecPath, env: {} },
      "1.2.3",
    )

    expect(status.status).toBe("matching")
    expect(status.packageVersion).toBe("1.2.3")
  })

  test("reports mismatching Desktop package version metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-doctor-version-"))
    const realExecPath = path.join(root, "Synergy.app", "Contents", "Resources", "synergy", "bin", "synergy")
    await fs.mkdir(path.dirname(realExecPath), { recursive: true })
    await fs.writeFile(
      path.join(root, "Synergy.app", "Contents", "Resources", "synergy", "desktop-package.json"),
      '{"version":"1.2.4"}',
    )

    const status = await DesktopInstallation.packageVersionStatus(
      { platform: "darwin", execPath: "/usr/local/bin/synergy", realExecPath, env: {} },
      "1.2.3",
    )

    expect(status.status).toBe("mismatch")
    expect(status.message).toContain("does not match")
  })

  test("reports unavailable Desktop package version metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-doctor-version-"))
    const realExecPath = path.join(root, "Synergy.app", "Contents", "Resources", "synergy", "bin", "synergy")

    const status = await DesktopInstallation.packageVersionStatus(
      { platform: "darwin", execPath: "/usr/local/bin/synergy", realExecPath, env: {} },
      "1.2.3",
    )

    expect(status.status).toBe("unavailable")
  })
})
