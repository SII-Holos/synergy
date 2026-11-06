import { describe, expect, test, spyOn } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentProviders, type EnvironmentProvider } from "../../src/environment/provider"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"
import { StorageRecovery } from "../../src/storage/recovery"

function provider() {
  const calls = { allocate: 0, deallocate: 0 }
  const allocations = new Map<string, { id: string; capabilities: string[] }>()
  const host: EnvironmentProvider = {
    id: "fixture",
    async allocate(request) {
      calls.allocate++
      const info = await Environment.get(request.environmentID, "scope")
      expect(info.state).toBe("allocating")
      expect(info.allocation?.requestID).toBe(request.requestID)
      const allocation = { id: request.requestID, capabilities: ["exec", "files"] }
      allocations.set(request.requestID, allocation)
      return allocation
    },
    async inspect(request) {
      const allocation = allocations.get(request.requestID)
      return allocation ? { state: "ready", allocation } : { state: "absent" }
    },
    async deallocate(request) {
      calls.deallocate++
      allocations.delete(request.requestID)
    },
  }
  return { host, calls }
}

describe("Environment lifecycle", () => {
  test("explicit default sharing selects one logical target without allocating", async () => {
    const { host, calls } = provider()
    await using runtime = await testRuntime({
      register() {
        EnvironmentProviders.register(host)
        EnvironmentProviders.setDefault({ provider: "fixture", spec: {}, reuse: "scope" })
      },
    })
    await runtime.run(async () => {
      const [a, b] = await Promise.all(["a", "b"].map((ownerID) => Environment.select({ scopeID: "scope", ownerID })))
      expect(a!.id).toBe(b!.id)
      expect((await Environment.binding("scope", "b"))?.id).toBe(a!.id)
      expect(calls.allocate).toBe(0)
      expect(await Environment.select({ scopeID: "scope", ownerID: "unbound", environmentID: null })).toBeUndefined()
    })
  })
  test("restart releases abandoned admission while retaining physical-operation uses", async () => {
    const { host } = provider()
    await using home = await runtimeHome()
    const first = await testRuntime({ home: home.host.home, register: () => EnvironmentProviders.register(host) })
    let id = ""
    try {
      await first.run(async () => {
        id = (await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "fixture", spec: {} })).id
        await Environment.acquire(id, { scopeID: "scope", useID: "preparing", capabilities: [], kind: "admission" })
        await Environment.acquire(id, { scopeID: "scope", useID: "operation", capabilities: [] })
        await StorageRecovery.recoverOwners()
        expect(await Environment.uses(id)).toHaveLength(2)
      })
    } finally {
      await first.close()
    }
    await using second = await testRuntime({
      home: home.host.home,
      register: () => EnvironmentProviders.register(host),
    })
    await second.run(async () => {
      expect((await Environment.uses(id)).map((use) => use.id)).toEqual(["operation"])
      await expect(Environment.deallocate(id, { scopeID: "scope" })).rejects.toMatchObject({ name: "EnvironmentBusy" })
    })
  })
  test("logical bindings allocate nothing; concurrent first uses share one durable allocation", async () => {
    const { host, calls } = provider()
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
    await runtime.run(async () => {
      const [first, second] = await Promise.all([
        Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} }),
        Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} }),
      ])
      expect(first.id).toBe(second.id)
      expect(calls.allocate).toBe(0)
      const [a, b] = await Promise.all([
        Environment.acquire(first.id, { scopeID: "scope", useID: "tool-a", capabilities: ["exec"] }),
        Environment.acquire(first.id, { scopeID: "scope", useID: "tool-b", capabilities: ["files"] }),
      ])
      expect(calls.allocate).toBe(1)
      expect(a.target).toEqual(b.target)
      await expect(Environment.deallocate(first.id, { scopeID: "scope" })).rejects.toMatchObject({
        name: "EnvironmentBusy",
      })
      await a.release()
      await b.release()
      await Environment.deallocate(first.id, { scopeID: "scope" })
      expect(calls.deallocate).toBe(1)
      const next = await Environment.acquire(first.id, { scopeID: "scope", useID: "tool-c", capabilities: ["exec"] })
      expect(next.target.generation).toBe(a.target.generation + 1)
      await expect(Environment.assertTarget(a.target, "scope")).rejects.toMatchObject({ name: "EnvironmentStale" })
      await next.release()
    })
  })

  test("missing capabilities and providers fail closed without a native fallback", async () => {
    const { host, calls } = provider()
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
    await runtime.run(async () => {
      const info = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
      await expect(
        Environment.acquire(info.id, { scopeID: "scope", useID: "pty", capabilities: ["pty"] }),
      ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
      expect(await Environment.uses(info.id)).toHaveLength(0)
      expect(calls.allocate).toBe(1)
      await expect(
        Environment.bind({ scopeID: "scope", ownerID: "other", provider: "missing", spec: {} }),
      ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
      await expect(Environment.get(info.id, "other")).rejects.toBeInstanceOf(Storage.NotFoundError)
    })
  })

  test("uncertain allocation is reconciled by request identity without repeating allocate", async () => {
    const { host, calls } = provider()
    const allocate = host.allocate
    host.allocate = async (request) => {
      await allocate(request)
      throw new Error("response lost")
    }
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
    await runtime.run(async () => {
      const info = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
      await expect(
        Environment.acquire(info.id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] }),
      ).rejects.toThrow("response lost")
      const use = await Environment.acquire(info.id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] })
      expect(calls.allocate).toBe(1)
      expect(use.target.generation).toBe(1)
      await use.release()
    })
  })

  test("registrations are Runtime-owned and sealed after startup", async () => {
    const { host } = provider()
    await using a = await testRuntime({ register: () => EnvironmentProviders.register(host) })
    await using b = await testRuntime()
    await a.run(async () => {
      expect(EnvironmentProviders.get("fixture")).toBe(host)
      expect(() => EnvironmentProviders.register({ ...host, id: "late" })).toThrow()
    })
    await b.run(async () => {
      expect(() => EnvironmentProviders.get("fixture")).toThrow()
    })
  })

  test("partially created allocations resume only their original unadmitted intent", async () => {
    const { host, calls } = provider()
    const allocate = host.allocate
    let pending = true
    let resumes = 0
    host.allocate = async () => {
      throw new Error("created resource, response lost")
    }
    host.inspect = async () => ({ state: "pending" })
    host.resume = async (request) => {
      resumes++
      pending = false
      return allocate(request)
    }
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
    await runtime.run(async () => {
      const info = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
      await expect(
        Environment.acquire(info.id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] }),
      ).rejects.toThrow("response lost")
      const before = await Environment.get(info.id, "scope")
      const use = await Environment.acquire(info.id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] })
      expect(pending).toBe(false)
      expect(resumes).toBe(1)
      expect(calls.allocate).toBe(1)
      expect(use.target.allocationID).toBe(before.allocation!.requestID)
      expect((await Environment.reconcile(info.id, "scope")).state).toBe("unavailable")
      expect(resumes).toBe(1)
      expect(await Environment.uses(info.id)).toHaveLength(1)
      await use.release()
    })
  })
})

test("a lost allocation with a retained Workspace view cannot become an empty replacement", async () => {
  const { host } = provider()
  let absent = false
  const inspect = host.inspect
  host.inspect = (request) => (absent ? Promise.resolve({ state: "absent" }) : inspect(request))
  await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
    const use = await Environment.acquire(environment.id, { scopeID: "scope", useID: "prepare", capabilities: [] })
    const { WorkspaceCatalog } = await import("../../src/workspace/catalog")
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    await Storage.write(["workspace", workspace.id], {
      ...workspace,
      activeMount: {
        id: "mount",
        generation: 1,
        target: use.target,
        path: "/workspace",
        state: "active",
        readOnly: false,
      },
    })
    await Storage.write(["workspace_environment", environment.id, workspace.id], "scope")
    await use.release()
    absent = true
    expect((await Environment.reconcile(environment.id, "scope")).state).toBe("unavailable")
    expect((await WorkspaceCatalog.get(workspace.id, "scope")).activeMount?.state).toBe("unavailable")
    await expect(
      Environment.acquire(environment.id, { scopeID: "scope", useID: "next", capabilities: [] }),
    ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
  })
})

test("Runtime maintenance reclaims idle managed compute and preserves active and borrowed allocations", async () => {
  const { host, calls } = provider()
  const borrowed = { ...host, id: "borrowed", ownership: "borrowed" as const }
  await using runtime = await testRuntime({
    register() {
      EnvironmentProviders.register(host)
      EnvironmentProviders.register(borrowed)
    },
  })
  await runtime.run(async () => {
    const idle = await Environment.bind({
      scopeID: "scope",
      ownerID: "idle",
      provider: "fixture",
      spec: {},
      idleTimeoutMs: 0,
    })
    const busy = await Environment.bind({
      scopeID: "scope",
      ownerID: "busy",
      provider: "fixture",
      spec: {},
      idleTimeoutMs: 0,
    })
    const native = await Environment.bind({
      scopeID: "scope",
      ownerID: "borrowed",
      provider: "borrowed",
      spec: {},
      idleTimeoutMs: 0,
    })
    await (await Environment.acquire(idle.id, { scopeID: "scope", useID: "once", capabilities: [] })).release()
    const active = await Environment.acquire(busy.id, { scopeID: "scope", useID: "active", capabilities: [] })
    await (await Environment.acquire(native.id, { scopeID: "scope", useID: "once", capabilities: [] })).release()
    const deadline = Date.now() + 20_000
    while ((await Environment.get(idle.id, "scope")).state !== "idle") {
      if (Date.now() > deadline) throw new Error("Runtime did not schedule idle reclamation")
      await Bun.sleep(50)
    }
    expect((await Environment.get(busy.id, "scope")).state).toBe("ready")
    expect((await Environment.get(native.id, "scope")).state).toBe("ready")
    expect(calls.deallocate).toBe(1)
    await active.release()
  })
}, 30_000)

test("Environment event snapshots have a strictly increasing update watermark", async () => {
  const { host } = provider()
  await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(host) })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "clock", provider: "fixture", spec: {} })
    const clock = spyOn(Date, "now").mockReturnValue(environment.updatedAt + 10)
    try {
      const use = await Environment.acquire(environment.id, { scopeID: "scope", useID: "work", capabilities: ["exec"] })
      const ready = await Environment.get(environment.id, "scope")
      await use.release()
      const released = await Environment.deallocate(environment.id, { scopeID: "scope" })
      expect(released.updatedAt).toBeGreaterThan(ready.updatedAt)
    } finally {
      clock.mockRestore()
    }
  })
})
