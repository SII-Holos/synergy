import { describe, expect, test } from "bun:test"
import path from "path"
import { DaemonPaths } from "../../src/daemon/paths"
import { renderSystemdUnit } from "../../src/daemon/systemd"

describe("daemon.systemd", () => {
  test("builds systemd user unit path under home config", () => {
    const unit = DaemonPaths.systemdUnit("synergy")
    expect(unit).toContain(path.join(".config", "systemd", "user", "synergy.service"))
  })

  test("continues the service when a child is killed by the OOM killer", () => {
    const unit = renderSystemdUnit({
      label: "synergy",
      hostname: "127.0.0.1",
      port: 4096,
      command: ["synergy", "serve"],
      cwd: "/workspace",
      env: {},
      logFile: "/tmp/synergy.log",
    })

    expect(unit).toContain("OOMPolicy=continue")
    expect(unit).toContain("KillMode=control-group")
  })
})
