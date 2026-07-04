import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/global/installation"

const env = {}

describe("Installation desktop detection", () => {
  test("detects macOS app bundle runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "darwin",
        execPath: "/usr/local/bin/synergy",
        realExecPath: "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
        env,
      }),
    ).toBe(true)
  })

  test("detects Windows installed runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "win32",
        execPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin\\synergy.cmd",
        realExecPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\resources\\synergy\\bin\\synergy.exe",
        env,
      }),
    ).toBe(true)
  })

  test("detects Linux deb runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "linux",
        execPath: "/usr/bin/synergy",
        realExecPath: "/opt/Synergy/resources/synergy/bin/synergy",
        env,
      }),
    ).toBe(true)
  })

  test("does not claim package-manager or unknown binaries", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "darwin",
        execPath: "/opt/homebrew/bin/synergy",
        realExecPath: "/opt/homebrew/bin/synergy",
        env,
      }),
    ).toBe(false)
    expect(
      Installation.detectDesktopInstall({
        platform: "linux",
        execPath: "/home/eric/.bun/bin/synergy",
        realExecPath: "/home/eric/.bun/install/global/node_modules/@ericsanchezok/synergy/bin/synergy",
        env,
      }),
    ).toBe(false)
  })

  test("desktop upgrades are delegated to the Desktop app", async () => {
    const err = await Installation.upgrade("desktop", "999.0.0").catch((error) => error)
    expect(err).toBeInstanceOf(Installation.DesktopManagedUpdateError)
    expect(err.data.message).toContain("Desktop updates are managed from the Synergy app")
  })
})
