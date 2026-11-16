import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { Bus } from "@ericsanchezok/synergy-harness/bus"

test("a registered Host revoked while the actual Executor connects cannot dispatch the command", async () => {
  await using temporary = await tmpdir()
  let live = true
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    workspaceCoordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    register() {
      host = EnvironmentOrigin.registerHost("limited-host", {
        async admission() {
          if (!live) throw new Error("Original Host authority was revoked")
        },
        async mutation() {},
      })
    },
  })
  await runtime.run(async () => {
    const scope = await temporary.scope()
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "host", provider: "native", spec: {} })
    const provider = EnvironmentProviders.get("native"),
      connect = provider.connect?.bind(provider)
    if (!connect || !host) throw new Error("Host fixture has no actual Native provider")
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    let actual: Executor | undefined
    provider.connect = async (request, target) => {
      actual = await connect(request, target)
      entered.resolve()
      await resume.promise
      return actual
    }
    const marker = path.join(temporary.path, "forbidden-effect")
    const pending = EnvironmentExecution.start({
      id: "held-connect",
      scopeID: scope.id,
      environmentID: environment.id,
      origin: host.capture("held-connect"),
      command: {
        command: process.execPath,
        args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'started')`],
        cwd: temporary.path,
        env: {},
        useRoots: [temporary.path],
      },
    })
    const observed = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await entered.promise
      live = false
      resume.resolve()
      const error = await observed
      let info = await EnvironmentExecution.get("held-connect", scope.id)
      while (info.status && !ExecutionProtocol.terminal(info.status)) {
        await actual?.waitForChange?.(info.id, info.status, 1000)
        info = await EnvironmentExecution.reconcile(info.id, scope.id)
      }
      if (info.state !== "completed") info = await EnvironmentExecution.complete(info.id, scope.id)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(error).toBeInstanceOf(Error)
      expect(info.status?.effectsStarted).toBe(false)
      expect(await Environment.uses(environment.id)).toHaveLength(0)
    } finally {
      resume.resolve()
      await observed
      const info = await EnvironmentExecution.reconcile("held-connect", scope.id)
      if (info.status && ExecutionProtocol.terminal(info.status)) await EnvironmentExecution.complete(info.id, scope.id)
      await Environment.deallocate(environment.id, { scopeID: scope.id })
    }
  })
})

test("a registered Host revoked after the allocating COMMIT cannot invoke the actual provider allocation", async () => {
  await using temporary = await tmpdir()
  let live = true
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    workspaceCoordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    register() {
      host = EnvironmentOrigin.registerHost("allocation-host", {
        async admission() {
          if (!live) throw new Error("Original Host authority was revoked")
        },
        async mutation() {},
      })
    },
  })
  await runtime.run(async () => {
    const scope = await temporary.scope()
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "host", provider: "native", spec: {} })
    const provider = EnvironmentProviders.get("native"),
      allocate = provider.allocate.bind(provider)
    let allocations = 0
    provider.allocate = async (request) => {
      allocations++
      return allocate(request)
    }
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const unsubscribe = Bus.subscribeGlobal(Environment.Event.Updated, async (event) => {
      if (event.properties.id !== environment.id || event.properties.state !== "allocating") return
      entered.resolve()
      await resume.promise
    })
    if (!host) throw new Error("Host fixture was not composed")
    const pending = Environment.acquire(environment.id, {
      scopeID: scope.id,
      useID: "allocation-gate",
      capabilities: ["exec"],
      ownership: host.capture("allocation-gate"),
    })
    const observed = pending.then(
      (use) => ({ use, error: undefined }),
      (error: unknown) => ({ use: undefined, error }),
    )
    try {
      await entered.promise
      expect(allocations).toBe(0)
      expect((await Environment.get(environment.id, scope.id)).state).toBe("allocating")
      live = false
      resume.resolve()
      const result = await observed
      await result.use?.release()
      const info = await Environment.get(environment.id, scope.id)
      expect((await provider.inspect(Environment.requestOf(info))).state).toBe("absent")
      expect(allocations).toBe(0)
      expect(result.error).toBeInstanceOf(Error)
      expect(await Environment.uses(environment.id)).toHaveLength(0)
    } finally {
      resume.resolve()
      unsubscribe()
      const result = await observed
      await result.use?.release()
      await Environment.reconcile(environment.id, scope.id)
      await Environment.deallocate(environment.id, { scopeID: scope.id })
    }
  })
})
