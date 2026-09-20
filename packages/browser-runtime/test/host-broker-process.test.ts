import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserHostBrokerProcess } from "../src/host-broker-process.js"
import type { BrowserOwner } from "../src/owner.js"
import { BunProc } from "@ericsanchezok/synergy-harness/util/bun"
import { testRuntime } from "./support/runtime"
let runtime: Awaited<ReturnType<typeof testRuntime>>
const env = {
  SYNERGY_BROWSER_HOST_AUTOSTART: "true",
  SYNERGY_BROWSER_HOST_COMMAND: idleStubCommand(),
  SYNERGY_BROWSER_HOST_SERVER_URL: undefined,
}
beforeEach(async () => {
  runtime = await testRuntime(undefined, env)
})
async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  await using isolated = await testRuntime(undefined, { ...env, ...overrides })
  return isolated.run(fn)
}

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "session",
  mode: "session",
}

function idleStubCommand() {
  return JSON.stringify([BunProc.which(), "-e", "setInterval(() => {}, 1000)"])
}

afterEach(() => runtime.close())

describe("BrowserHostBrokerProcess", () => {
  test("can be disabled explicitly", () =>
    withEnv({ SYNERGY_BROWSER_HOST_AUTOSTART: "false" }, () => {
      expect(BrowserHostBrokerProcess.enabled()).toBe(false)
    }))

  test("uses one broker process for every page", () =>
    runtime.run(async () => {
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
    }))

  test("prefers the SYNERGY_BROWSER_HOST_SERVER_URL override", () =>
    withEnv({ SYNERGY_BROWSER_HOST_SERVER_URL: "http://override.internal:5000" }, async () => {
      const result = await BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "https://client-facing.example.com",
        routeDirectory: "scope",
      })
      expect(result.status).toBe("started")
      expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://override.internal:5000")
    }))

  test("rewrites a wildcard listen address to loopback for the Host callback", () =>
    runtime.run(async () => {
      BrowserHostBrokerProcess.configureServerUrl("http://0.0.0.0:4096/")
      const result = await BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "https://client-facing.example.com",
        routeDirectory: "scope",
      })
      expect(result.status).toBe("started")
      expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://127.0.0.1:4096")
    }))

  test("rewrites an IPv6 wildcard listen address to loopback", () =>
    runtime.run(async () => {
      BrowserHostBrokerProcess.configureServerUrl("http://[::]:4096/")
      const result = await BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "https://client-facing.example.com",
        routeDirectory: "scope",
      })
      expect(result.status).toBe("started")
      expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("http://[::1]:4096")
    }))

  test("falls back to the request origin for an invalid SYNERGY_BROWSER_HOST_SERVER_URL override", () =>
    withEnv({ SYNERGY_BROWSER_HOST_SERVER_URL: "not a url" }, async () => {
      const result = await BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "https://client-facing.example.com",
        routeDirectory: "scope",
      })
      expect(result.status).toBe("started")
      expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("https://client-facing.example.com")
    }))

  test("spawns a single Host process for concurrent ensure calls", () =>
    runtime.run(async () => {
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
    }))

  test("falls back to the request origin without a configured listen address", () =>
    runtime.run(async () => {
      const result = await BrowserHostBrokerProcess.ensure({
        owner,
        serverUrl: "https://client-facing.example.com",
        routeDirectory: "scope",
      })
      expect(result.status).toBe("started")
      expect(BrowserHostBrokerProcess.activeServerUrl()).toBe("https://client-facing.example.com")
    }))

  test("restarts the Host process when the callback URL changes", () =>
    runtime.run(async () => {
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
    }))
})

test("source Browser Host command resolves a runnable Desktop workspace", () =>
  withEnv({ SYNERGY_BROWSER_HOST_COMMAND: undefined }, async () => {
    const command = await BrowserHostBrokerProcess.resolveCommand()
    const cwd = command[command.indexOf("--cwd") + 1]!
    const manifest = Bun.file(path.join(cwd, "package.json"))
    expect(await manifest.exists()).toBe(true)
    expect((await manifest.json()).scripts[command.at(-1)!]).toBeString()
  }))

test("an installed Browser runtime does not assume a Desktop source checkout", () =>
  runtime.run(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-browser-package-"))
    try {
      expect(
        await BrowserHostBrokerProcess.sourceCommand(path.join(directory, "node_modules/browser-runtime/dist")),
      ).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }))
