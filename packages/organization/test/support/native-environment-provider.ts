import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import type { EnvironmentProvider, EnvironmentRequest } from "@ericsanchezok/synergy-harness/environment/provider"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { NativeExecutor } from "@ericsanchezok/synergy-local-runtime/environment/native-executor"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"

export function controlledEnvironment(directory: string, coordinator: WorkspaceCoordinator) {
  const Spec = z.strictObject({})
  const Allocation = z.strictObject({ version: z.literal(1), target: Environment.Target })
  const executors = new Map<string, NativeExecutor>()
  let allocations = 0
  const location = (request: EnvironmentRequest) =>
    path.join(directory, createHash("sha256").update(request.environmentID).digest("hex"))
  const target = (request: EnvironmentRequest) =>
    Environment.Target.parse({
      environmentID: request.environmentID,
      allocationID: request.requestID,
      generation: request.generation,
    })
  async function existing(request: EnvironmentRequest) {
    const file = Bun.file(path.join(location(request), "allocation.json"))
    return (await file.exists()) ? Allocation.parse(await file.json()) : undefined
  }
  async function openExecutor(request: EnvironmentRequest, selected: Environment.Target) {
    let executor = executors.get(request.requestID)
    if (!executor) {
      executor = await NativeExecutor.open({
        target: selected,
        directory: path.join(location(request), request.requestID),
        coordinator,
        runtime: {
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          directory: path.join(location(request), request.requestID, "work"),
          env: {},
        },
      })
      executors.set(request.requestID, executor)
    }
    return executor
  }
  async function connect(request: EnvironmentRequest, selected: Environment.Target) {
    const retained = await existing(request)
    if (
      !retained ||
      !Environment.sameTarget(retained.target, target(request)) ||
      !Environment.sameTarget(selected, retained.target)
    )
      throw new Error("Controlled Environment has another retained allocation")
    return openExecutor(request, selected)
  }
  const provider: EnvironmentProvider = {
    id: "controlled-execution-host",
    ownership: "managed",
    validateSpec: (value) => Spec.parse(value),
    async allocate(request) {
      Spec.parse(request.spec)
      const retained = await existing(request)
      if (retained && !Environment.sameTarget(retained.target, target(request)))
        throw new Error("Controlled Environment cannot replace an unknown allocation")
      await openExecutor(request, target(request))
      if (!retained) {
        await AtomicFile.writeJsonAtomic(
          path.join(location(request), "allocation.json"),
          JSON.stringify({ version: 1, target: target(request) }),
          { private: true, durable: true },
        )
        allocations++
      }
      return { id: request.requestID, capabilities: ["exec", "pty", "files"] }
    },
    async inspect(request) {
      const retained = await existing(request)
      if (!retained) return { state: "absent" }
      if (!Environment.sameTarget(retained.target, target(request))) return { state: "unknown" }
      const root = await fs.stat(path.join(location(request), request.requestID, "work")).catch(() => undefined)
      if (!root?.isDirectory()) return { state: "unknown" }
      return { state: "ready", allocation: { id: request.requestID, capabilities: ["exec", "pty", "files"] } }
    },
    connect,
    async deallocate(request) {
      const retained = await existing(request)
      if (!retained) return
      if (!Environment.sameTarget(retained.target, target(request)))
        throw new Error("Controlled Environment cannot release another allocation")
      await executors.get(request.requestID)?.close()
      executors.delete(request.requestID)
      await fs.unlink(path.join(location(request), "allocation.json"))
    },
    async close() {
      await Promise.all([...executors.values()].map((executor) => executor.close()))
      executors.clear()
    },
  }
  return { provider, allocations: () => allocations }
}
