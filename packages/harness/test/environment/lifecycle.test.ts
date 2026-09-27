import { describe, expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentProviders, type EnvironmentProvider } from "../../src/environment/provider"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

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
