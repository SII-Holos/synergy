import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  EnvironmentProviders,
  type EnvironmentProvider,
  type EnvironmentRequest,
} from "@ericsanchezok/synergy-harness/environment/provider"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { WorkspaceCoordinator } from "../workspace/coordinator"
import { NativeExecutor } from "./native-executor"
import { Shell } from "@ericsanchezok/synergy-harness/util/shell"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { ProcessEnvironment } from "../process/environment"
import { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"

const Allocation = z.object({ id: z.string(), capabilities: z.array(z.string()), target: Environment.Target })

export function registerNativeEnvironment(options: { coordinator?: WorkspaceCoordinator } = {}) {
  const root = path.join(RuntimeContext.current().host.root, "state", "environments")
  const executors = new Map<string, Promise<NativeExecutor>>()
  const coordinator = options.coordinator ?? new WorkspaceCoordinator()
  const filename = (request: EnvironmentRequest) =>
    path.join(root, createHash("sha256").update(request.environmentID).digest("hex"), "allocation.json")
  const provider: EnvironmentProvider = {
    id: "native",
    ownership: "borrowed",
    validateSpec: (spec) => z.object({}).strict().parse(spec),
    async workspacePath(_request, workspace) {
      return (await WorkspaceBinding.validate(workspace.id, workspace.scopeID, workspace.binding.generation)).path
    },
    async allocate(request) {
      const target = {
        environmentID: request.environmentID,
        allocationID: request.requestID,
        generation: request.generation,
      }
      const allocation = { id: request.requestID, capabilities: ["exec", "pty", "files"], target }
      const current = await provider.inspect(request)
      if (current.state === "ready") return current.allocation
      if (current.state === "unknown") throw new Error("Native Environment has another allocation")
      await AtomicFile.writeJsonAtomic(filename(request), JSON.stringify(allocation), { private: true, durable: true })
      return allocation
    },
    async inspect(request) {
      const file = Bun.file(filename(request))
      if (!(await file.exists())) return { state: "absent" }
      const allocation = Allocation.parse(await file.json())
      if (allocation.id !== request.requestID || allocation.target.generation !== request.generation)
        return { state: "unknown" }
      return { state: "ready", allocation }
    },
    async connect(request, target) {
      const status = await provider.inspect(request)
      if (
        status.state !== "ready" ||
        !Environment.sameTarget(target, {
          environmentID: request.environmentID,
          allocationID: status.allocation.id,
          generation: request.generation,
        })
      )
        throw new Error("Native Environment allocation is unavailable")
      let pending = executors.get(request.requestID)
      if (!pending) {
        pending = NativeExecutor.open({
          target,
          directory: path.join(path.dirname(filename(request)), request.requestID),
          coordinator,
          files: { acquire: WorkspaceAccess.hostClaim },
          sandbox: SandboxHost,
          runtime: {
            shell: Shell.acceptable(),
            directory: path.join(path.dirname(filename(request)), request.requestID, "work"),
            env: ProcessEnvironment.select(RuntimeContext.current().host.env),
          },
          acquire: (command, signal) =>
            WorkspaceAccess.process([...new Set([command.cwd, ...command.useRoots])], signal, {
              retainAfterExit: true,
              durable: true,
              cooperative: command.cooperative,
              mutationRoots: [
                ...(command.mutationRoots ?? []),
                ...(command.preconditions ?? []).map((condition) => condition.canonical),
              ],
            }),
        })
        executors.set(request.requestID, pending)
        void pending.catch(() => executors.delete(request.requestID))
      }
      return pending
    },
    async deallocate(request) {
      const status = await provider.inspect(request)
      if (status.state === "absent") return
      if (status.state === "unknown") throw new Error("Cannot release another native allocation")
      await (await executors.get(request.requestID))?.close()
      executors.delete(request.requestID)
      await fs.unlink(filename(request))
      await AtomicFile.syncDirectories(path.dirname(filename(request)))
    },
    async close() {
      const results = await Promise.allSettled(
        [...executors.values()].map(async (executor) => (await executor).close()),
      )
      executors.clear()
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Native Environment shutdown failed")
    },
  }
  EnvironmentProviders.register(provider)
}
