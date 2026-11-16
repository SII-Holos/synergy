import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders, type EnvironmentRequest } from "@ericsanchezok/synergy-harness/environment/provider"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("inspection recovery does not resume an original partial native allocation", async () => {
  await using temporary = await tmpdir()
  const home = path.join(temporary.path, "home")
  const partial = path.join(temporary.path, "partial-allocation.json")
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  let resumed = 0
  let inspection = true
  let id = ""
  let retainedID = ""
  const register = () => {
    host = EnvironmentOrigin.registerHost("inspection-allocation")
    const provider = EnvironmentProviders.get("native")
    const allocate = provider.allocate.bind(provider),
      inspect = provider.inspect.bind(provider)
    provider.allocate = async (request) => {
      if (request.environmentID !== id) return allocate(request)
      await Bun.write(partial, JSON.stringify(request))
      throw new Error("Native allocation is durably partial")
    }
    provider.inspect = async (request) => {
      const actual = await inspect(request)
      if (actual.state !== "absent" || !(await Bun.file(partial).exists())) return actual
      const original: EnvironmentRequest = await Bun.file(partial).json()
      if (JSON.stringify(original) !== JSON.stringify(request)) return { state: "unknown" }
      return { state: "pending" }
    }
    provider.resume = async (request) => {
      resumed++
      const result = await allocate(request)
      await fs.unlink(partial)
      return result
    }
    if (inspection) Environment.registerRecovery({ allocation: "inspect-only" })
  }
  let allocating: Environment.Info | undefined
  const first = await testRuntime({ home, workspaceCoordinator: coordinator, register })
  try {
    await first.run(async () => {
      retainedID = (
        await Environment.bind({ scopeID: "inspection-scope", ownerID: "retained", provider: "native", spec: {} })
      ).id
      if (!host) throw new Error("Original Host was not registered")
      await Environment.acquire(retainedID, {
        scopeID: "inspection-scope",
        useID: "original-admission",
        ownership: host.capture("original-admission"),
        capabilities: ["exec"],
      })
      expect(await Environment.uses(retainedID)).toHaveLength(1)
      id = (await Environment.bind({ scopeID: "inspection-scope", ownerID: "host", provider: "native", spec: {} })).id
      await expect(
        Environment.acquire(id, {
          scopeID: "inspection-scope",
          useID: "pending",
          ownership: host.capture("pending"),
          capabilities: ["exec"],
        }),
      ).rejects.toThrow("durably partial")
      allocating = await Environment.get(id, "inspection-scope")
      expect(allocating.state).toBe("allocating")
      expect(await Environment.uses(id)).toHaveLength(0)
    })
  } finally {
    await first.close()
  }
  const original = allocating
  if (!original) throw new Error("The original Native allocation intent was not recorded")
  const second = await testRuntime({ home, workspaceCoordinator: coordinator, register })
  try {
    await second.run(async () => {
      expect(resumed).toBe(0)
      expect((await Environment.uses(retainedID)).map((use) => use.id)).toEqual(["original-admission"])
      expect(await Environment.get(id, "inspection-scope")).toEqual(original)
      const provider = EnvironmentProviders.get("native")
      expect((await provider.inspect(Environment.requestOf(await Environment.get(id, "inspection-scope")))).state).toBe(
        "pending",
      )
      expect(await Environment.reconcileInspection(id, "inspection-scope")).toEqual(original)
      expect(resumed).toBe(0)
    })
  } finally {
    await second.close()
    inspection = false
    await using cleanup = await testRuntime({ home, workspaceCoordinator: coordinator, register })
    await cleanup.run(async () => {
      const current = await Environment.get(id, "inspection-scope")
      expect(resumed).toBe(1)
      expect(current.state).toBe("ready")
      expect((await EnvironmentProviders.get("native").inspect(Environment.requestOf(current))).state).toBe("ready")
      expect(await Environment.uses(id)).toHaveLength(0)
      expect(await Environment.uses(retainedID)).toHaveLength(0)
      await Environment.deallocate(id, { scopeID: "inspection-scope" })
      await Environment.deallocate(retainedID, { scopeID: "inspection-scope" })
    })
  }
})
