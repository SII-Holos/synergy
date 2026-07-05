import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyRuntime } from "../src/runtime"
import { MetaSynergyStore } from "../src/state/store"

const originalMetaHome = process.env.META_SYNERGY_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-managed-test-"))
  const synergyHome = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-managed-synergy-"))
  tempRoots.push(root, synergyHome)
  process.env.META_SYNERGY_HOME = root
  process.env.SYNERGY_TEST_HOME = synergyHome
})

afterAll(async () => {
  if (originalMetaHome === undefined) {
    delete process.env.META_SYNERGY_HOME
  } else {
    process.env.META_SYNERGY_HOME = originalMetaHome
  }
  if (originalSynergyHome === undefined) {
    delete process.env.SYNERGY_TEST_HOME
  } else {
    process.env.SYNERGY_TEST_HOME = originalSynergyHome
  }

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("meta-synergy managed mode", () => {
  test("startup stays healthy without Holos auth or websocket", async () => {
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "managed"
    state.ownerRegistry.local.activeOwnerID = "synergy:test"
    state.ownerRegistry.local.ownerIDs = ["synergy:test"]
    state.ownerRegistry.local.leaseExpiresAt = Date.now() + 60_000
    await MetaSynergyStore.saveState(state)
    await writeFile(
      MetaSynergyStore.ownerRegistryPath(),
      JSON.stringify(
        {
          local: {
            ownerIDs: ["synergy:test"],
            activeOwnerID: "synergy:test",
            leaseExpiresAt: Date.now() + 60_000,
          },
        },
        null,
        2,
      ) + "\n",
    )

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
    expect(runtime.state?.ownerRegistry.local.activeOwnerID).toBe("synergy:test")

    const status = await runtime.getStatusPayload()
    expect(status.mode).toBe("managed")
    expect(status.auth).toEqual({
      loggedIn: false,
      agentID: null,
      source: null,
      hiddenReason: null,
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

  test("startup recovers managed state without an active owner back to standalone", async () => {
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "managed"
    state.ownerRegistry.local.activeOwnerID = undefined
    state.ownerRegistry.local.ownerIDs = []
    state.ownerRegistry.local.leaseExpiresAt = undefined
    await MetaSynergyStore.saveState(state)
    await writeFile(
      MetaSynergyStore.ownerRegistryPath(),
      JSON.stringify(
        {
          local: {
            ownerIDs: [],
            activeOwnerID: null,
            leaseExpiresAt: null,
          },
        },
        null,
        2,
      ) + "\n",
    )

    const runtime = await MetaSynergyRuntime.create()
    expect(runtime.state?.runtimeMode).toBe("standalone")
    expect(runtime.state?.ownerRegistry.local.activeOwnerID).toBeUndefined()
  })
})
