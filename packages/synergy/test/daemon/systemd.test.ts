import { describe, expect, test } from "bun:test"
import { SYSTEMD_SERVER_SHUTDOWN_TIMEOUT_SECONDS } from "@ericsanchezok/synergy-util/runtime-shutdown"
import path from "path"
import { DaemonPaths } from "../../src/util/daemon-paths"
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

  test("keeps the service stop timeout beyond the maximum runtime deadline", () => {
    const unit = renderSystemdUnit({
      label: "synergy",
      hostname: "127.0.0.1",
      port: 4096,
      command: ["synergy", "serve"],
      cwd: "/workspace",
      env: {},
      logFile: "/tmp/synergy.log",
    })

    expect(unit).toContain(`TimeoutStopSec=${SYSTEMD_SERVER_SHUTDOWN_TIMEOUT_SECONDS}`)
  })
})
