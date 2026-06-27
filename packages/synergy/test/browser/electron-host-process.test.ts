import { afterEach, describe, expect, test } from "bun:test"
import { BrowserElectronHostProcess } from "../../src/browser/electron-host-process.js"
import { BrowserHostControl } from "../../src/browser/host-control.js"
import type { BrowserOwner } from "../../src/browser/owner.js"
import { BunProc } from "../../src/util/bun.js"

const originalAutostart = process.env.SYNERGY_BROWSER_HOST_AUTOSTART
const originalCommand = process.env.SYNERGY_BROWSER_HOST_COMMAND
const originalHostLog = process.env.SYNERGY_BROWSER_HOST_LOG
const originalReadyTimeout = process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS
const originalRestartLimit = process.env.SYNERGY_BROWSER_HOST_RESTART_LIMIT

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "ses_host_process",
  mode: "session",
}

function restoreEnv() {
  if (originalAutostart === undefined) delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART
  else process.env.SYNERGY_BROWSER_HOST_AUTOSTART = originalAutostart
  if (originalCommand === undefined) delete process.env.SYNERGY_BROWSER_HOST_COMMAND
  else process.env.SYNERGY_BROWSER_HOST_COMMAND = originalCommand
  if (originalHostLog === undefined) delete process.env.SYNERGY_BROWSER_HOST_LOG
  else process.env.SYNERGY_BROWSER_HOST_LOG = originalHostLog
  if (originalReadyTimeout === undefined) delete process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS
  else process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS = originalReadyTimeout
  if (originalRestartLimit === undefined) delete process.env.SYNERGY_BROWSER_HOST_RESTART_LIMIT
  else process.env.SYNERGY_BROWSER_HOST_RESTART_LIMIT = originalRestartLimit
}

function idleHostCommand(): string {
  return JSON.stringify([BunProc.which(), "-e", "setInterval(() => {}, 1000)"])
}

describe("BrowserElectronHostProcess", () => {
  afterEach(() => {
    restoreEnv()
    BrowserElectronHostProcess.resetForTest()
    BrowserHostControl.resetForTest()
  })

  test("autostarts Browser Hosts by default", () => {
    delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART

    expect(BrowserElectronHostProcess.enabled()).toBe(true)
  })

  test("can disable Browser Host autostart explicitly", () => {
    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "0"
    expect(BrowserElectronHostProcess.enabled()).toBe(false)

    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "false"
    expect(BrowserElectronHostProcess.enabled()).toBe(false)
  })

  test("restarts a live host process when control never becomes ready", () => {
    process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS = "0"
    process.env.SYNERGY_BROWSER_HOST_RESTART_LIMIT = "1"
    process.env.SYNERGY_BROWSER_HOST_LOG = "0"
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleHostCommand()

    const input = {
      owner,
      tabId: "tab_1",
      serverUrl: "http://localhost:4096",
      routeDirectory: "scope",
    }

    expect(BrowserElectronHostProcess.ensure(input).status).toBe("started")
    expect(BrowserElectronHostProcess.ensure(input).status).toBe("restarted")
    expect(BrowserElectronHostProcess.ensure(input).status).toBe("failed")
    expect(BrowserHostControl.status(owner, "tab_1")).toBe("failed")
  })
})
