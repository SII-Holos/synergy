import { Environment } from "."
import { EnvironmentExecution } from "./execution"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { ExecutionProtocol } from "./executor"

const requirement = (code: string, label: string): RuntimeMaintenance.Requirement => ({
  code,
  label,
  owner: "environments",
  recoverable: true,
})

async function inspect(signal: AbortSignal, final = true) {
  const requirements = new Map<string, RuntimeMaintenance.Requirement>()
  const add = (code: string, label: string) => requirements.set(code, requirement(code, label))
  signal.throwIfAborted()
  if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
    add("environment_request_active", "Wait for the current native Environment requests to settle")
  for await (const use of Environment.useEntries()) {
    signal.throwIfAborted()
    if (use.ownership.kind === "legacy-unknown") {
      add(
        "environment_use_unknown",
        "Resolve the retained historical Environment Use through its original native owner",
      )
      continue
    }
    await Environment.inspectUse(use)
    if (final || use.kind === "admission")
      add("environment_use_retained", "Release the original Environment Use after its native owner has drained")
  }
  for await (const row of Storage.records<string>({ prefix: StoragePath.environmentActive(), limit: 128 })) {
    signal.throwIfAborted()
    if (row.key.length !== 2 || typeof row.value !== "string")
      throw new Error("Environment maintenance found an invalid active allocation index")
    const info = await Environment.get(row.key[1], row.value)
    if (info.state !== "ready" && info.state !== "idle")
      add("environment_allocation_unsettled", "Reconcile the current Environment allocation before maintenance")
  }
  for await (const row of Storage.records({ prefix: StoragePath.environmentExecutionActive(), limit: 128 })) {
    signal.throwIfAborted()
    if (row.key.length !== 3) throw new Error("Environment maintenance found an invalid active execution index")
    const info = await EnvironmentExecution.get(row.key[2], row.key[1])
    if (info.state !== "completed")
      add(
        "environment_execution_unsettled",
        "Confirm native process, stream and Workspace save completion before maintenance",
      )
  }
  return [...requirements.values()]
}

async function reconcileNativeOperation(
  context: RuntimeMaintenance.Context,
  phase: "frozen" | "releasing" | "released",
) {
  const held = await RuntimeMaintenance.assertNativeReconciliation(context.lease, phase)
  const requirements = new Map<string, RuntimeMaintenance.Requirement>()
  const add = (code: string, label: string) => requirements.set(code, requirement(code, label))
  try {
    context.signal.throwIfAborted()
    if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
      add("environment_request_active", "Wait for the original native Environment requests")
    for await (const environment of Environment.entries()) {
      context.signal.throwIfAborted()
      if (environment.state !== "idle" || environment.allocation !== undefined)
        add(
          "environment_allocation_retained",
          "Reconcile the original allocation before recovering this native operation",
        )
    }
    for await (const use of Environment.useEntries()) {
      context.signal.throwIfAborted()
      if (use.ownership.kind === "legacy-unknown")
        add("environment_use_unknown", "Resolve the retained Environment Use through its original owner")
      else add("environment_use_retained", "Release the original Environment Use after native drainage")
    }
    for await (const execution of EnvironmentExecution.entries()) {
      context.signal.throwIfAborted()
      if (execution.origin.kind === "legacy-unknown") {
        add("environment_execution_unknown", "Resolve the retained execution through its original native owner")
        continue
      }
      const status = execution.status
      if (
        execution.state !== "completed" ||
        !status ||
        !ExecutionProtocol.terminal(status) ||
        status.id !== execution.id ||
        status.digest !== execution.digest ||
        !Environment.sameTarget(status.target, execution.target) ||
        status.cursor !== execution.outputCursor
      )
        add(
          "environment_execution_unsettled",
          "Confirm the original process, streams and complete saved execution receipt",
        )
      if (execution.sourceObservation !== undefined) {
        const original = EnvironmentExecution.Info.parse(execution.sourceObservation)
        if (original.origin.kind === "legacy-unknown")
          add(
            "environment_execution_unknown",
            "Resolve the original remote execution owner before recovering this Home",
          )
      }
    }
  } catch (cause) {
    context.signal.throwIfAborted()
    throw new RuntimeMaintenance.Blocked(
      {
        maintenanceID: held.maintenanceID,
        message: "Cold Environment inventory is invalid or belongs to another canonical owner",
        requirements: [
          requirement("environment_inventory_unknown", "Inspect the original canonical Environment inventory"),
        ],
      },
      { cause },
    )
  }
  if (requirements.size)
    throw new RuntimeMaintenance.Blocked({
      maintenanceID: held.maintenanceID,
      message: "Native Environment ownership still blocks this native operation",
      requirements: [...requirements.values()],
    })
  const after = await RuntimeMaintenance.assertNativeReconciliation(context.lease, phase)
  if (JSON.stringify(after) !== JSON.stringify(held))
    throw new RuntimeMaintenance.Blocked({
      message: "Cold Environment inspection changed its original native operation",
    })
}

export function registerEnvironmentMaintenanceOwner() {
  RuntimeMaintenance.register("environments", {
    version: 1,
    order: 200,
    async suspend(context) {
      await RuntimeMaintenance.assertDraining(context.lease)
    },
    async drain(context) {
      await RuntimeMaintenance.assertDraining(context.lease)
      if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
        throw new RuntimeMaintenance.Blocked({
          message: "Native Environment requests are still active",
          requirements: [
            requirement("environment_request_active", "Wait for the current native Environment requests to settle"),
          ],
        })
      for await (const row of Storage.records({ prefix: StoragePath.environmentExecutionActive(), limit: 128 })) {
        context.signal.throwIfAborted()
        if (row.key.length !== 3) throw new Error("Environment maintenance found an invalid active execution index")
        const info = await EnvironmentExecution.reconcile(row.key[2], row.key[1])
        if (["exited", "unsaved", "saved"].includes(info.state))
          await EnvironmentExecution.complete(info.id, info.scopeID)
      }
      const requirements = await inspect(context.signal, false)
      if (requirements.length)
        throw new RuntimeMaintenance.Blocked({
          message: "Native Environment writers need reconciliation",
          requirements,
        })
    },
    async inspect(context) {
      const held =
        context.purpose === "organization-home-upgrade"
          ? await RuntimeMaintenance.operation(context.maintenanceID)
          : undefined
      if (held?.version === 2 && held.phase === "released") {
        await reconcileNativeOperation(context, "released")
        return []
      }
      return inspect(context.signal)
    },
    reconcileFrozen: (context) => reconcileNativeOperation(context, "frozen"),
    reconcileReleasing: (context) => reconcileNativeOperation(context, "releasing"),
    async release(context) {
      context.signal.throwIfAborted()
    },
  })
}
