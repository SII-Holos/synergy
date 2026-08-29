import { describe, expect, spyOn, test } from "bun:test"
import { Ripgrep } from "../../src/file/ripgrep"
import { Plugin } from "../../src/plugin"
import { registerPluginStartup } from "../../src/plugin/startup"
import { ScopeRuntime } from "../../src/scope/runtime"
import { tmpdir } from "../fixture/fixture"

registerPluginStartup()

describe("ScopeRuntime", () => {
  test("does not start a repository index until file search needs it", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalFiles = Ripgrep.files
    const mutableRipgrep = Ripgrep as { files: typeof Ripgrep.files }
    let scans = 0
    mutableRipgrep.files = async function* () {
      scans++
      yield "partial.ts"
    }

    try {
      await ScopeRuntime.ensure(scope)
      await Promise.resolve()
      expect(scans).toBe(0)
    } finally {
      mutableRipgrep.files = originalFiles
      await ScopeRuntime.dispose(scope.id)
    }
  })

  test("notifies starting listeners before plugin initialization", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const order: string[] = []
    const unsubscribe = ScopeRuntime.onStarting((startingScope) => {
      expect(startingScope.id).toBe(scope.id)
      order.push("listener")
    })
    using _activateScope = spyOn(Plugin, "activateScope").mockImplementation(() => {
      order.push("activate")
    })
    using _init = spyOn(Plugin, "init").mockImplementation(async () => {
      order.push("init")
    })

    try {
      await ScopeRuntime.ensure(scope)
      expect(order).toEqual(["activate", "listener", "init"])
    } finally {
      unsubscribe()
      await ScopeRuntime.dispose(scope.id)
    }
  })

  test("waits for in-flight startup before disposal and a later restart", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    let releaseStartup!: () => void
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    let initCalls = 0
    let disposeCalls = 0
    using _init = spyOn(Plugin, "init").mockImplementation(async () => {
      initCalls++
      if (initCalls === 1) await startupGate
    })
    using _disposeScope = spyOn(Plugin, "disposeScope").mockImplementation(async () => {
      disposeCalls++
    })

    const firstEnsure = ScopeRuntime.ensure(scope)
    await Bun.sleep(1)
    expect(initCalls).toBe(1)

    const disposal = ScopeRuntime.dispose(scope.id)
    const secondEnsure = ScopeRuntime.ensure(scope)
    await Bun.sleep(1)
    expect(disposeCalls).toBe(0)
    expect(initCalls).toBe(1)

    releaseStartup()
    await Promise.all([firstEnsure, disposal, secondEnsure])
    expect(disposeCalls).toBe(1)
    expect(initCalls).toBe(2)

    await ScopeRuntime.dispose(scope.id)
  })
})
