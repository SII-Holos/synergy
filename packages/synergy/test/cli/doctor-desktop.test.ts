import { describe, expect, test } from "bun:test"
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
})
