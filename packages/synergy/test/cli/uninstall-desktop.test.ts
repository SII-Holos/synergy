import { describe, expect, test } from "bun:test"
import { DesktopInstallation } from "../../src/global/desktop-installation"

describe("desktop-managed uninstall helpers", () => {
  test("collects platform CLI link paths without app bundle removal targets", () => {
    expect(
      DesktopInstallation.linkPath({
        platform: "darwin",
        execPath: "/usr/local/bin/synergy",
        realExecPath: "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
        env: {},
      }),
    ).toBe("/usr/local/bin/synergy")

    expect(
      DesktopInstallation.linkPath({
        platform: "linux",
        execPath: "/usr/bin/synergy",
        realExecPath: "/opt/Synergy/resources/synergy/bin/synergy",
        env: {},
      }),
    ).toBe("/usr/bin/synergy")
  })

  test("keeps Windows launcher directory separate from runtime internals", () => {
    const context = {
      platform: "win32" as const,
      execPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin\\synergy.cmd",
      realExecPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\resources\\synergy\\bin\\synergy.exe",
      env: {},
    }

    expect(DesktopInstallation.launcherDirectory(context)).toBe(
      "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin",
    )
    expect(DesktopInstallation.linkPath(context)).toBe(
      "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin\\synergy.cmd",
    )
    expect(DesktopInstallation.launcherDirectory(context)).not.toContain("resources\\synergy\\bin")
  })

  test("removes only the exact Windows Desktop launcher directory from User PATH", async () => {
    const launcherDir = "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin"
    const pathValue = [
      "C:\\Windows\\System32",
      launcherDir,
      "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin-extra",
      "C:\\Tools",
    ].join(";")

    expect(DesktopInstallation.removePathEntry(pathValue, launcherDir.toLowerCase(), "win32")).toBe(
      "C:\\Windows\\System32;C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin-extra;C:\\Tools",
    )
  })

  test("updates Windows User PATH store and broadcasts when launcher entry is removed", async () => {
    const writes: string[] = []
    let broadcastCount = 0
    const result = await DesktopInstallation.removeWindowsUserPathEntry("C:\\Synergy\\bin", {
      async read() {
        return "C:\\Windows;C:\\Synergy\\bin;C:\\Synergy\\bin-extra"
      },
      async write(value) {
        writes.push(value)
      },
      async broadcast() {
        broadcastCount++
      },
    })

    expect(result.removed).toBe(true)
    expect(writes).toEqual(["C:\\Windows;C:\\Synergy\\bin-extra"])
    expect(broadcastCount).toBe(1)
  })

  test("does not write Windows User PATH when the launcher entry is absent", async () => {
    const writes: string[] = []
    const result = await DesktopInstallation.removeWindowsUserPathEntry("C:\\Synergy\\bin", {
      async read() {
        return "C:\\Windows;C:\\Synergy\\bin-extra"
      },
      async write(value) {
        writes.push(value)
      },
    })

    expect(result.removed).toBe(false)
    expect(writes).toEqual([])
  })
})
