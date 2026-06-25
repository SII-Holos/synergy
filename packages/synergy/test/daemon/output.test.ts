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
