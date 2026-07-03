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
})
