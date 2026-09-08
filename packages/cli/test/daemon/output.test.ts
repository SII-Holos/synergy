import { afterEach, describe, expect, test } from "bun:test"
import { DaemonOutput } from "../../src/daemon/output"
import type { Daemon } from "../../src/daemon"

const status: Daemon.Status = {
  installed: true,
  manager: "launchd",
  runtime: "running",
  specSource: "installed",
  drifted: false,
  url: "http://127.0.0.1:4096",
  desiredUrl: "http://127.0.0.1:4096",
  reachable: true,
  portListening: true,
  logFile: "/tmp/synergy/server.log",
  desiredLogFile: "/tmp/synergy/server.log",
}

describe("DaemonOutput", () => {
  let originalWrite: typeof process.stderr.write

  afterEach(() => {
    process.stderr.write = originalWrite
  })

  test("status output uses plain no-ansi rendering when not in a fancy terminal", () => {
    originalWrite = process.stderr.write.bind(process.stderr)
    const output: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      output.push(String(chunk))
      return true
    }) as any

    DaemonOutput.printStatus(status)

    const text = output.join("")
    expect(text).not.toContain("\x1b[")
    expect(text).toContain("Synergy background service")
    expect(text).toContain("Manager: launchd")
    expect(text).toContain("Runtime: running")
    expect(text).toContain("synergy web")
  })

  test("stop success includes follow-up commands", () => {
    originalWrite = process.stderr.write.bind(process.stderr)
    const output: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      output.push(String(chunk))
      return true
    }) as any

    DaemonOutput.printStopSuccess()

    const text = output.join("")
    expect(text).toContain("Synergy background service stopped")
    expect(text).toContain("synergy start")
    expect(text).toContain("synergy status")
  })
})

test("status and log guidance distinguish drift, health failures and an unmanaged listener", () => {
  const original = process.stderr.write
  const output: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    for (const scenario of [
      { installed: false, runtime: "unknown", text: "configured address is still active" },
      { installed: false, runtime: "stopped", text: "No managed Synergy service is installed" },
      { installed: true, runtime: "failed", text: "did not pass health checks" },
      { installed: true, runtime: "unknown", text: "does not match the service manager state" },
      { installed: true, runtime: "running", text: "Current config differs" },
      { installed: true, runtime: "stopped", text: "Current config differs" },
    ] as const) {
      output.length = 0
      const observed: Daemon.Status = {
        ...status,
        installed: scenario.installed,
        runtime: scenario.runtime,
        specSource: "desired",
        drifted: true,
        desiredLogFile: "/tmp/new/server.log",
        detail: "first line\nprivate second line",
      }
      DaemonOutput.printStatus(observed)
      expect(output.join("")).toContain(scenario.text)
      expect(output.join("")).not.toContain("private second line")
      expect(output.join("")).toContain("Config Log")
      DaemonOutput.printLogHeader({ filePath: status.logFile, status: observed })
      expect(output.join("")).toContain("Synergy background service logs")
      expect(output.join("")).toContain("synergy start")
    }
    output.length = 0
    DaemonOutput.printLogHeader({ filePath: status.logFile, status })
    expect(output.join("")).not.toContain("Current config path")
  } finally {
    process.stderr.write = original
  }
})

test("service output preserves actionable failures, custom recovery and observed listener details", () => {
  const original = process.stderr.write
  const output: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    DaemonOutput.printServiceSummary({
      title: "Configured",
      manager: "launchd",
      url: status.url,
      logFile: status.logFile,
      detail: "loaded\nignored",
      notes: ["note"],
      next: ["custom next"],
    })
    expect(output.join("")).toContain("Configured")
    expect(output.join("")).toContain("custom next")
    expect(output.join("")).not.toContain("ignored")
    output.length = 0
    DaemonOutput.printStartFailure({
      message: "Start failed",
      manager: "launchd",
      runtime: "failed",
      url: status.url,
      logFile: status.logFile,
      detail: "service detail",
    })
    expect(output.join("")).toContain("Start failed")
    expect(output.join("")).toContain("synergy logs")
    DaemonOutput.printStopFailure({
      message: "Stop failed",
      runtime: "unknown",
      url: status.url,
      logFile: status.logFile,
      detail: "service detail",
      notes: ["inspect process"],
      next: ["custom stop"],
    })
    expect(output.join("")).toContain("custom stop")
    DaemonOutput.printStopFailure({ message: "Stop failed", url: status.url, logFile: status.logFile })
    expect(output.join("")).toContain("synergy stop")
    DaemonOutput.printStopSuccess({ portStopped: false, url: status.url })
    expect(output.join("")).toContain("another process is listening")
    output.length = 0
    DaemonOutput.printNoService({ activeUrl: status.url })
    expect(output.join("")).toContain("Stop the other process")
    DaemonOutput.printNoService()
    expect(output.join("")).toContain("synergy start")
  } finally {
    process.stderr.write = original
  }
})
