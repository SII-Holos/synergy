import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyRuntime } from "../src/runtime"
import { MetaSynergyStore } from "../src/state/store"

const originalHome = process.env.META_SYNERGY_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-managed-test-"))
  tempRoots.push(root)
  process.env.META_SYNERGY_HOME = root
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.META_SYNERGY_HOME
  } else {
    process.env.META_SYNERGY_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("meta-synergy managed mode", () => {
  test("startup stays healthy without Holos auth or websocket", async () => {
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "managed"
    await MetaSynergyStore.saveState(state)

    const runtime = await MetaSynergyRuntime.create()
    const originalLogin = runtime.login.bind(runtime)
    let loginCalled = false
    runtime.login = async () => {
      loginCalled = true
      return await originalLogin()
    }

    const startPromise = runtime.start()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(loginCalled).toBe(false)
    expect(runtime.state?.runtimeMode).toBe("managed")
    expect(runtime.state?.connectionStatus).toBe("disconnected")
    expect(runtime.state?.service.runtimeStatus).toBe("running")
    expect(runtime.state?.ownerRegistry.local.activeOwnerID).toMatch(/^env_/)

    const status = await runtime.getStatusPayload()
    expect(status.mode).toBe("managed")
    expect(status.auth).toEqual({
      loggedIn: false,
      agentID: null,
      source: null,
    })
    expect(status.ownership.local.owned).toBe(true)

    const reconnect = await runtime.reconnect()
    expect(reconnect.requested).toBe(false)
    expect(reconnect.reason).toBe("Holos is disabled in managed mode")

    await runtime.stopServerProcess()
    await Promise.race([
      startPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("runtime.start did not settle after stop")), 2_000)),
    ])
  })
})
