import { describe, expect, spyOn, test } from "bun:test"
import { SYSTEMD_SERVER_SHUTDOWN_TIMEOUT_SECONDS } from "@ericsanchezok/synergy-util/runtime-shutdown"
import path from "path"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { SystemdUserService, renderSystemdUnit } from "../../src/daemon/systemd"

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

async function withSystemd(
  run: (
    spec: Parameters<typeof SystemdUserService.install>[0],
    calls: string[][],
    reply: (value: { exitCode: number; stdout?: string; stderr?: string; failAction?: string }) => void,
  ) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const previousHome = process.env.SYNERGY_HOME
  process.env.SYNERGY_HOME = tmp.path
  const calls: string[][] = []
  let response: { exitCode: number; stdout: string; stderr: string; failAction?: string } = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  }
  const spawn = spyOn(Bun, "spawn").mockImplementation((command) => {
    if (!Array.isArray(command) || command[0] !== "systemctl") throw new Error("unexpected OS operation")
    calls.push(command as string[])
    const value =
      response.failAction && command[2] !== response.failAction ? { exitCode: 0, stdout: "", stderr: "" } : response
    return {
      stdout: new Response(value.stdout).body,
      stderr: new Response(value.stderr).body,
      exited: Promise.resolve(value.exitCode),
    } as never
  })
  const spec = {
    label: "synergy-unit-fixture",
    hostname: "127.0.0.1",
    port: 49123,
    command: ["/app path/synergy", "server"],
    cwd: tmp.path,
    env: { SAMPLE: 'quoted "value"' },
    logFile: DaemonPaths.logFile(),
  }
  try {
    await run(spec, calls, (value) => {
      response = { stdout: "", stderr: "", ...value }
    })
  } finally {
    spawn.mockRestore()
    if (previousHome === undefined) delete process.env.SYNERGY_HOME
    else process.env.SYNERGY_HOME = previousHome
  }
}

test("systemd lifecycle persists the user unit and translates manager state without starting OS services", async () => {
  await withSystemd(async (spec, calls, reply) => {
    await SystemdUserService.install(spec)
    expect(await Bun.file(DaemonPaths.systemdUnit(spec.label)).text()).toContain('ExecStart="/app path/synergy" server')
    expect(calls.slice(0, 3)).toEqual([
      ["systemctl", "--user", "status"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${spec.label}.service`],
    ])
    await SystemdUserService.start(spec)
    await SystemdUserService.stop(spec)
    await SystemdUserService.restart(spec)
    expect(calls.filter((call) => ["start", "stop", "restart"].includes(call[2]!)).map((call) => call[2])).toEqual([
      "start",
      "stop",
      "restart",
    ])
    reply({
      exitCode: 0,
      stdout:
        "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=123\nIgnored=line=value\nmalformed",
    })
    expect(await SystemdUserService.status(spec)).toEqual({
      installed: true,
      running: true,
      detail: "LoadState=loaded, ActiveState=active, SubState=running, UnitFileState=enabled, MainPID=123",
    })
    await SystemdUserService.uninstall(spec)
    expect(await Bun.file(DaemonPaths.systemdUnit(spec.label)).exists()).toBe(false)
    expect(calls.at(-2)).toEqual(["systemctl", "--user", "disable", "--now", `${spec.label}.service`])
    reply({
      exitCode: 0,
      stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nMainPID=0",
    })
    expect(await SystemdUserService.status(spec)).toMatchObject({ installed: false, running: false })
  })
})

test("systemd unavailable preserves installed evidence and reports actionable errors", async () => {
  await withSystemd(async (spec, _calls, reply) => {
    await Bun.write(DaemonPaths.systemdUnit(spec.label), "installed unit")
    for (const detail of [
      "systemctl: command not found",
      "Failed to connect to bus: No medium found",
      "permission denied",
      "",
    ]) {
      reply({ exitCode: 1, stderr: detail })
      const status = await SystemdUserService.status(spec)
      expect(status).toMatchObject({ installed: true, running: false })
      expect(status.detail).toContain(
        detail.includes("not found") ? "systemctl not available" : "systemctl --user unavailable",
      )
      await expect(SystemdUserService.start(spec)).rejects.toThrow("systemctl")
      expect(await Bun.file(DaemonPaths.systemdUnit(spec.label)).text()).toBe("installed unit")
    }
  })
})

test("systemd renderer quotes arguments and rejects multiline environment injection", () => {
  const spec = {
    label: "fixture",
    hostname: "127.0.0.1",
    port: 1,
    command: ["synergy", 'a"b', "c\\d"],
    cwd: "/tmp",
    env: { SAFE: "first\nsecond" },
    logFile: "/tmp/log",
  }
  expect(() => renderSystemdUnit(spec)).toThrow("must not contain CR or LF")
  const unit = renderSystemdUnit({ ...spec, env: { SAFE: "two words" } })
  expect(unit).toContain('Environment=SAFE="two words"')
  expect(unit).toContain('"a\\"b"')
})

test("systemd propagates operation failures and reports failed show output without losing installed evidence", async () => {
  await withSystemd(async (spec, _calls, reply) => {
    await SystemdUserService.install(spec)
    reply({ exitCode: 1, stderr: "start operation denied", failAction: "start" })
    await expect(SystemdUserService.start(spec)).rejects.toThrow("start operation denied")
    reply({ exitCode: 1, stdout: "unit has a bad setting", failAction: "show" })
    expect(await SystemdUserService.status(spec)).toEqual({
      installed: true,
      running: false,
      detail: "unit has a bad setting",
    })
    reply({ exitCode: 1, stderr: "already stopped", failAction: "disable" })
    await SystemdUserService.uninstall(spec)
    expect(await Bun.file(DaemonPaths.systemdUnit(spec.label)).exists()).toBe(false)
  })
})
