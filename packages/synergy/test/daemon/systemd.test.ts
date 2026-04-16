import { describe, expect, test } from "bun:test"
import path from "path"
import { DaemonPaths } from "../../src/daemon/paths"

describe("daemon.systemd paths", () => {
  test("builds systemd user unit path under home config", () => {
    const unit = DaemonPaths.systemdUnit("synergy")
    expect(unit).toContain(path.join(".config", "systemd", "user", "synergy.service"))
  })
})
