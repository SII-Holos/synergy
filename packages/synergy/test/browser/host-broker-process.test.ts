import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHostBrokerProcess } from "../../src/browser/host-broker-process.js"
import { BrowserBroker } from "../../src/browser/broker.js"
import type { BrowserOwner } from "../../src/browser/owner.js"
import { BunProc } from "../../src/util/bun.js"

const originalAutostart = process.env.SYNERGY_BROWSER_HOST_AUTOSTART
const originalCommand = process.env.SYNERGY_BROWSER_HOST_COMMAND
const originalServerUrl = process.env.SYNERGY_BROWSER_HOST_SERVER_URL

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "session",
  mode: "session",
}

function idleStubCommand() {
  return JSON.stringify([BunProc.which(), "-e", "setInterval(() => {}, 1000)"])
}

afterEach(async () => {
  await BrowserHostBrokerProcess.stop().catch(() => undefined)
  if (originalAutostart === undefined) delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART
  else process.env.SYNERGY_BROWSER_HOST_AUTOSTART = originalAutostart
  if (originalCommand === undefined) delete process.env.SYNERGY_BROWSER_HOST_COMMAND
  else process.env.SYNERGY_BROWSER_HOST_COMMAND = originalCommand
  if (originalServerUrl === undefined) delete process.env.SYNERGY_BROWSER_HOST_SERVER_URL
  else process.env.SYNERGY_BROWSER_HOST_SERVER_URL = originalServerUrl
  BrowserHostBrokerProcess.resetForTest()
  BrowserBroker.resetForTest()
})

describe("BrowserHostBrokerProcess", () => {
  test("can be disabled explicitly", () => {
    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "false"
    expect(BrowserHostBrokerProcess.enabled()).toBe(false)
  })

  test("uses one broker process for every page", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
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

  test("prefers the SYNERGY_BROWSER_HOST_SERVER_URL override", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    process.env.SYNERGY_BROWSER_HOST_SERVER_URL = "http://override.internal:5000"
    const result = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "https://client-facing.example.com",
      routeDirectory: "scope",
    })
    expect(result.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://override.internal:5000")
  })

  test("rewrites a wildcard listen address to loopback for the Host callback", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    BrowserHostBrokerProcess.configureServerUrl("http://0.0.0.0:4096/")
    const result = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "https://client-facing.example.com",
      routeDirectory: "scope",
    })
    expect(result.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://127.0.0.1:4096")
  })

  test("falls back to the request origin without a configured listen address", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    const result = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "https://client-facing.example.com",
      routeDirectory: "scope",
    })
    expect(result.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("https://client-facing.example.com")
  })

  test("restarts the Host process when the callback URL changes", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    const first = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "http://localhost:4096",
      routeDirectory: "scope",
    })
    expect(first.status).toBe("started")
    const second = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "http://localhost:4097",
      routeDirectory: "scope",
    })
    expect(second.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://localhost:4097")
    const third = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "http://localhost:4097",
      routeDirectory: "scope",
    })
    expect(third.status).toBe("running")
  })
})
