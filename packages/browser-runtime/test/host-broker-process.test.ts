import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHostBrokerProcess } from "../src/host-broker-process.js"
import { BrowserBroker } from "../src/broker.js"
import type { BrowserOwner } from "../src/owner.js"
import { BunProc } from "@ericsanchezok/synergy-harness/util/bun"

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

  test("rewrites an IPv6 wildcard listen address to loopback", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    BrowserHostBrokerProcess.configureServerUrl("http://[::]:4096/")
    const result = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "https://client-facing.example.com",
      routeDirectory: "scope",
    })
    expect(result.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://[::1]:4096")
  })

  test("falls back to the request origin for an invalid SYNERGY_BROWSER_HOST_SERVER_URL override", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    process.env.SYNERGY_BROWSER_HOST_SERVER_URL = "not a url"
    const result = await BrowserHostBrokerProcess.ensure({
      owner,
      serverUrl: "https://client-facing.example.com",
      routeDirectory: "scope",
    })
    expect(result.status).toBe("started")
    expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("https://client-facing.example.com")
  })

  test("spawns a single Host process for concurrent ensure calls", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = idleStubCommand()
    const [first, second, third] = await Promise.all([
      BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "http://localhost:4096",
        routeDirectory: "scope",
      }),
      BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "http://localhost:4096",
        routeDirectory: "scope",
      }),
      BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "http://localhost:4096",
        routeDirectory: "scope",
      }),
    ])
    expect(first.status).toBe("started")
    expect(second.status).toBe("running")
    expect(third.status).toBe("running")
    expect(BrowserHostBrokerProcess.resourceStats().processCount).toBe(1)
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

test("source Browser Host command resolves a runnable Desktop workspace", async () => {
  delete process.env.SYNERGY_BROWSER_HOST_COMMAND
  const command = await BrowserHostBrokerProcess.resolveCommand()
  const cwd = command[command.indexOf("--cwd") + 1]!
  const manifest = Bun.file(path.join(cwd, "package.json"))
  expect(await manifest.exists()).toBe(true)
  expect((await manifest.json()).scripts[command.at(-1)!]).toBeString()
})

test("an installed Browser runtime does not assume a Desktop source checkout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-browser-package-"))
  try {
    expect(
      await BrowserHostBrokerProcess.sourceCommand(path.join(directory, "node_modules/browser-runtime/dist")),
    ).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
