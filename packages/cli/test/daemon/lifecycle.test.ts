import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { DaemonState } from "@ericsanchezok/synergy-harness/util/daemon-state"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { Daemon } from "../../src/daemon"
import { DaemonSpec } from "../../src/daemon/spec"
import { DaemonService } from "../../src/daemon/service"
import { DaemonHealth } from "../../src/daemon/health"
import { StartCommand } from "../../src/cli/cmd/start"
import { StopCommand } from "../../src/cli/cmd/stop"
import { StatusCommand } from "../../src/cli/cmd/status"
import { UI } from "../../src/util/ui"

class RequestedExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

async function fixture(
  run: (f: {
    spec: Daemon.Spec
    service: DaemonService.Service
    calls: string[]
    output: string[]
    state: { installed: boolean; running: boolean; healthy: boolean; rejectStart: boolean; refuseStop: boolean }
  }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const previousHome = process.env.SYNERGY_HOME
  const previousExitCode = process.exitCode
  process.env.SYNERGY_HOME = tmp.path
  const state = { installed: false, running: false, healthy: true, rejectStart: false, refuseStop: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ healthy: state.healthy, version: "test", modelReady: false }),
  })
  const calls: string[] = [],
    output: string[] = []
  const spec: Daemon.Spec = {
    label: "test.synergy.daemon",
    hostname: "127.0.0.1",
    connectHostname: "127.0.0.1",
    port: server.port!,
    url: server.url.origin,
    command: ["fixture-synergy", "server"],
    cwd: tmp.path,
    env: { SYNERGY_DAEMON: "1" },
    logFile: DaemonPaths.logFile(),
    mdns: false,
    cors: [],
  }
  const service: DaemonService.Service = {
    manager: "systemd-user",
    async install() {
      calls.push("install")
      state.installed = true
    },
    async uninstall() {
      calls.push("uninstall")
      state.installed = false
    },
    async start() {
      calls.push("start")
      if (state.rejectStart) throw new Error("fixture service refused start")
      state.running = true
    },
    async restart() {
      calls.push("restart")
      state.running = true
    },
    async stop() {
      calls.push("stop")
      if (state.refuseStop) return
      state.running = false
      await server.stop(true)
    },
    async status() {
      return { installed: state.installed, running: state.running }
    },
  }
  const mocks = [
    spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    }),
    spyOn(DaemonService, "resolve").mockResolvedValue(service),
    spyOn(DaemonSpec, "resolve").mockImplementation(async () => ({ ...spec })),
    spyOn(UI, "println").mockImplementation((...args) => {
      output.push(args.join(""))
    }),
    spyOn(process, "exit").mockImplementation((code) => {
      throw new RequestedExit(Number(code ?? 0))
    }),
  ]
  try {
    await Bun.write(ConfigDomain.filepath("general"), "{}")
    await run({ spec, service, calls, output, state })
  } finally {
    await server.stop(true)
    for (const mock of mocks.reverse()) mock.mockRestore()
    process.exitCode = previousExitCode ?? 0
    if (previousHome === undefined) delete process.env.SYNERGY_HOME
    else process.env.SYNERGY_HOME = previousHome
  }
}

const startArgs = {
  _: [],
  $0: "synergy",
  "non-interactive": true,
  nonInteractive: true,
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  cors: [],
}

test("daemon installs starts restarts and uninstalls with durable manifest and real health observations", async () => {
  await fixture(async ({ spec, calls }) => {
    await Daemon.install()
    expect(await DaemonState.readManifest()).toMatchObject({
      label: spec.label,
      url: spec.url,
      manager: "systemd-user",
    })
    await Daemon.start()
    expect(calls).toEqual(["install", "start"])
    expect((await DaemonState.readManifest())?.lastStartedAt).toBeNumber()
    expect((await Daemon.waitForRunning(1_000, 1)).ok).toBe(true)
    expect(await Daemon.status()).toMatchObject({
      runtime: "running",
      reachable: true,
      portListening: true,
      drifted: false,
      specSource: "installed",
    })
    await Daemon.restart()
    expect(calls.at(-1)).toBe("restart")
    await Daemon.stop()
    expect((await Daemon.waitForStopped(1_000, 1)).ok).toBe(true)
    expect((await Daemon.waitForRunning(0, 1)).ok).toBe(false)
    await Daemon.uninstall()
    expect(await DaemonState.readManifest()).toBeUndefined()
    expect((await Daemon.status()).installed).toBe(false)
  })
})

test("CLI start reports readiness, preserves installed drift, verbose status and stop use real daemon state", async () => {
  await fixture(async ({ spec, calls, output }) => {
    await StartCommand.handler!(startArgs)
    expect(output.join("\n")).toContain("background service started")
    expect(output.join("\n")).toContain("No AI model configured")
    const oldURL = spec.url
    spec.url = "http://127.0.0.1:1"
    spec.port = 1
    output.length = 0
    await StartCommand.handler!(startArgs)
    expect(output.join("\n")).toContain("installed settings")
    expect(output.join("\n")).toContain(oldURL)
    expect(calls.filter((call) => call === "start")).toHaveLength(1)
    await StatusCommand.handler!({ _: [], $0: "synergy", verbose: true })
    expect(output.join("\n")).toContain("Diagnostics")
    expect(output.join("\n")).toContain("Runtime lock: none")
    await Bun.write(
      DaemonPaths.runtimeLock(),
      JSON.stringify({ pid: 123, startedAt: 1, command: ["fixture-synergy"], cwd: spec.cwd, mode: "daemon" }),
    )
    const inspect = spyOn(ServerProcessLock, "inspect").mockResolvedValue({
      pid: 123,
      alive: true,
      healthy: true,
      ppid: 1,
      cpu: 2,
      elapsed: "00:01",
      listeningPorts: [spec.port],
      command: "fixture-synergy server",
    })
    try {
      await StatusCommand.handler!({ _: [], $0: "synergy", verbose: true })
      expect(output.join("\n")).toContain("Runtime lock: pid=123")
      expect(output.join("\n")).toContain("Listening ports:")
      expect(output.join("\n")).toContain("Command: fixture-synergy server")
    } finally {
      inspect.mockRestore()
    }
    await StopCommand.handler!({ _: [], $0: "synergy" })
    expect(output.join("\n")).toContain("stopped")
    await Daemon.uninstall()
    output.length = 0
    await StopCommand.handler!({ _: [], $0: "synergy" })
    expect(output.join("\n")).toContain("No managed Synergy background service is installed")
  })
})

test("CLI refuses unknown ownership and surfaces service startup errors with an exit status", async () => {
  await fixture(async ({ state, output }) => {
    await Daemon.install()
    state.installed = false
    expect((await Daemon.status()).runtime).toBe("unknown")
    await expect(StartCommand.handler!(startArgs)).rejects.toThrow("exit 1")
    expect(output.join("\n")).toContain("Another Synergy process")
    await StatusCommand.handler!({ _: [], $0: "synergy", verbose: false })
    expect(process.exitCode).toBe(1)
    await Daemon.uninstall()
    state.rejectStart = true
    output.length = 0
    await expect(StartCommand.handler!(startArgs)).rejects.toThrow("exit 1")
    expect(output.join("\n")).toContain("fixture service refused start")
    expect(output.join("\n")).toContain("synergy server")
  })
})

test("CLI reports failed readiness and a refused stop through bounded real health polling", async () => {
  const waitRunning = Daemon.waitForRunning,
    waitStopped = Daemon.waitForStopped,
    waitPort = DaemonHealth.waitForPortToStop
  await fixture(async ({ state, output }) => {
    state.healthy = false
    const running = spyOn(Daemon, "waitForRunning").mockImplementation(() => waitRunning(0, 1))
    const stopped = spyOn(Daemon, "waitForStopped").mockImplementation(() => waitStopped(0, 1))
    const port = spyOn(DaemonHealth, "waitForPortToStop").mockImplementation((value, host) =>
      waitPort(value, host, 0, 1),
    )
    try {
      await expect(StartCommand.handler!(startArgs)).rejects.toThrow("exit 1")
      expect(output.join("\n")).toContain("did not become ready")
      expect(output.join("\n")).toContain("did not pass health checks")
      state.refuseStop = true
      output.length = 0
      await expect(StopCommand.handler!({ _: [], $0: "synergy" })).rejects.toThrow("exit 1")
      expect(output.join("\n")).toContain("stop did not complete")
    } finally {
      running.mockRestore()
      stopped.mockRestore()
      port.mockRestore()
    }
  })
})
