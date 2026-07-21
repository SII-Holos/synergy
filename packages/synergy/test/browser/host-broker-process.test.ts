import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHostBrokerProcess } from "../../src/browser/host-broker-process.js"
import { BrowserBroker } from "../../src/browser/broker.js"
import type { BrowserOwner } from "../../src/browser/owner.js"
import { BunProc } from "../../src/util/bun.js"

const originalAutostart = process.env.SYNERGY_BROWSER_HOST_AUTOSTART
const originalCommand = process.env.SYNERGY_BROWSER_HOST_COMMAND

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "session",
  mode: "session",
}

afterEach(async () => {
  await BrowserHostBrokerProcess.stop().catch(() => undefined)
  if (originalAutostart === undefined) delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART
  else process.env.SYNERGY_BROWSER_HOST_AUTOSTART = originalAutostart
  if (originalCommand === undefined) delete process.env.SYNERGY_BROWSER_HOST_COMMAND
  else process.env.SYNERGY_BROWSER_HOST_COMMAND = originalCommand
  BrowserHostBrokerProcess.resetForTest()
  BrowserBroker.resetForTest()
})

describe("BrowserHostBrokerProcess", () => {
  test("can be disabled explicitly", () => {
    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "false"
    expect(BrowserHostBrokerProcess.enabled()).toBe(false)
  })

  test("uses one broker process for every page", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = JSON.stringify([BunProc.which(), "-e", "setInterval(() => {}, 1000)"])
    const first = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "http://localhost:4096",
      routeDirectory: "scope",
    })
    const second = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "http://localhost:4096",
      routeDirectory: "scope",
    })
    expect(first).toEqual({ status: "started", key: "browser-host-broker" })
    expect(second).toEqual({ status: "running", key: "browser-host-broker" })
    await BrowserHostBrokerProcess.stop()
    expect(BrowserHostBrokerProcess.status()).toBe("idle")
  })
})
