import { describe, expect, test } from "bun:test"
import path from "path"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"

describe("daemon.schtasks paths", () => {
  test("builds a Windows task script path under daemon state", () => {
    const script = DaemonPaths.windowsTaskScript()
    expect(path.basename(script)).toBe("synergy.cmd")
  })
})
