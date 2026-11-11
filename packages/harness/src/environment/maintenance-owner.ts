import { Environment } from "."
import { EnvironmentExecution } from "./execution"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"

const requirement = (code: string, label: string): RuntimeMaintenance.Requirement => ({ code, label, owner: "environments", recoverable: true })

async function inspect(signal: AbortSignal) {
  const requirements = new Map<string, RuntimeMaintenance.Requirement>()
  const add = (code: string, label: string) => requirements.set(code, requirement(code, label))
  signal.throwIfAborted()
  if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
    add("environment_request_active", "Wait for the current native Environment requests to settle")
  for await (const row of Storage.records<string>({ prefix: StoragePath.environmentActive(), limit: 128 })) {
    signal.throwIfAborted()
    if (row.key.length !== 2 || typeof row.value !== "string") throw new Error("Environment maintenance found an invalid active allocation index")
    const info = await Environment.get(row.key[1], row.value)
    if (info.state !== "ready" && info.state !== "idle")
      add("environment_allocation_unsettled", "Reconcile the current Environment allocation before maintenance")
  }
  for await (const row of Storage.records({ prefix: StoragePath.environmentExecutionActive(), limit: 128 })) {
    signal.throwIfAborted()
    if (row.key.length !== 3) throw new Error("Environment maintenance found an invalid active execution index")
    const info = await EnvironmentExecution.get(row.key[2], row.key[1])
    if (info.state !== "completed")
      add("environment_execution_unsettled", "Confirm native process, stream and Workspace save completion before maintenance")
  }
  return [...requirements.values()]
}

export function registerEnvironmentMaintenanceOwner() {
  RuntimeMaintenance.register("environments", {
    version: 1,
    order: 200,
    async suspend(context) { await RuntimeMaintenance.assertDraining(context.lease) },
    async drain(context) {
      await RuntimeMaintenance.assertDraining(context.lease)
      if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
        throw new RuntimeMaintenance.Blocked({ message: "Native Environment requests are still active", requirements: [requirement("environment_request_active", "Wait for the current native Environment requests to settle")] })
      for await (const row of Storage.records({ prefix: StoragePath.environmentExecutionActive(), limit: 128 })) {
        context.signal.throwIfAborted()
        if (row.key.length !== 3) throw new Error("Environment maintenance found an invalid active execution index")
        const info = await EnvironmentExecution.reconcile(row.key[2], row.key[1])
        if (["exited", "unsaved", "saved"].includes(info.state)) await EnvironmentExecution.complete(info.id, info.scopeID)
      }
      const requirements = await inspect(context.signal)
      if (requirements.length) throw new RuntimeMaintenance.Blocked({ message: "Native Environment writers need reconciliation", requirements })
    },
    inspect: (context) => inspect(context.signal),
    async release(context) { context.signal.throwIfAborted() },
  })
}
