import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { addAbortListener } from "node:events"
import type { WorkspaceCoordinator } from "../workspace/coordinator"

export namespace NativeProcessMaintenance {
  export interface Evidence {
    started: boolean
    settled: boolean
  }
  interface Active {
    completion: Promise<void>
    failure?: unknown
  }
  const state = RuntimeContext.state(() => ({
    coordinators: new Set<WorkspaceCoordinator>(),
    active: new Set<Active>(),
  }))

  export async function prepare<T extends { completion: Promise<void> }>(body: (evidence: Evidence) => Promise<T>): Promise<T> {
    const evidence = { started: false, settled: false }
    if (!RuntimeContext.tryCurrent()) return body(evidence)
    const current = state()
    if (!current.coordinators.size) throw new Error("Native process ownership is not registered in this Runtime")
    const completion = Promise.withResolvers<void>()
    const active: Active = { completion: completion.promise }
    current.active.add(active)
    const finish = (error?: unknown) => {
      if (error && !evidence.settled) active.failure = error
      else current.active.delete(active)
      completion.resolve()
    }
    try {
      await RuntimeMaintenance.assertAdmission()
      const process = await body(evidence)
      void process.completion.then(() => finish(), finish)
      return process
    } catch (error) {
      finish(evidence.started ? error : undefined)
      throw error
    }
  }

  async function requirements(): Promise<RuntimeMaintenance.Requirement[]> {
    const current = state()
    if ([...current.active].some((active) => active.failure !== undefined))
      return [{ owner: "native-processes", code: "native_completion_unknown", label: "Reconcile the original native process completion and final ownership release", recoverable: true }]
    if (current.active.size)
      return [{ owner: "native-processes", code: "native_process_active", label: "Wait for native process trees, output streams and ownership release", recoverable: true }]
    if (!current.coordinators.size) throw new Error("Native process coordination is unavailable")
    const root = RuntimeContext.current().host.root
    const belongsToHome = (claim: Awaited<ReturnType<WorkspaceCoordinator["inspect"]>>[number]) => {
      if (claim.kind === "use") return false
      try {
        const owner: unknown = JSON.parse(claim.owner)
        return Array.isArray(owner) && owner[0] === root
      } catch { return false }
    }
    for (const coordinator of current.coordinators)
      if ((await coordinator.inspect()).some(belongsToHome))
        return [{ owner: "native-processes", code: "native_writer_retained", label: "Reconcile retained native Workspace writers and their original final saves", recoverable: true }]
    return []
  }

  export function register(coordinator: WorkspaceCoordinator) {
    RuntimeContext.assertCompositionOpen("Native process maintenance")
    const current = state()
    if (current.coordinators.has(coordinator)) return
    current.coordinators.add(coordinator)
    if (current.coordinators.size > 1) return
    RuntimeMaintenance.register("native-processes", {
      version: 1, order: 300,
      async suspend(context) { await RuntimeMaintenance.assertDraining(context.lease) },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        while ([...state().active].some((active) => active.failure === undefined)) {
          context.signal.throwIfAborted()
          const aborted = Promise.withResolvers<never>()
          using listener = addAbortListener(context.signal, () => aborted.reject(context.signal.reason))
          await Promise.race([Promise.all([...state().active].map((active) => active.completion)), aborted.promise])
        }
        const pending = await requirements()
        if (pending.length) throw new RuntimeMaintenance.Blocked({ message: "Physical native writers require reconciliation", requirements: pending })
      },
      async inspect(context) { context.signal.throwIfAborted(); return requirements() },
      async release(context) { await RuntimeMaintenance.assertReleasing(context.lease) },
    })
  }
}
