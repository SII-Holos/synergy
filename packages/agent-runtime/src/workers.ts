import type { FeaturePlan } from "@ericsanchezok/synergy-util/features"
import { ComponentWorkerPlan } from "@ericsanchezok/synergy-util/worker-plan"
import { Features } from "@ericsanchezok/synergy-harness/lifecycle/features"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerHarness, RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { registerPolicyWorkerEntrypoint } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"

export function registerRuntimeWorkers(components: readonly RuntimeComponent[], features: FeaturePlan) {
  const environment = { SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components, features)) }
  registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url), environment)
  registerPolicyWorkerEntrypoint(new URL("./policy-worker.ts", import.meta.url), environment)
}

export type WorkerPlan = ComponentWorkerPlan

export function workerPlan(components: readonly RuntimeComponent[], features: FeaturePlan): WorkerPlan {
  const entries = (role: "agent" | "policy") =>
    components.flatMap((component) => {
      const entry = component.workers?.[role]
      return entry ? [{ id: component.id, version: component.version, entry: entry.href }] : []
    })
  return ComponentWorkerPlan.parse({ apiVersion: 2, agent: entries("agent"), policy: entries("policy"), features })
}

export async function registerWorkerComponents(role: "agent" | "policy") {
  const raw = RuntimeContext.current().host.env.SYNERGY_WORKER_COMPONENTS
  if (!raw) throw new Error("A component worker requires its host's pinned composition")
  const plan = ComponentWorkerPlan.parse(JSON.parse(raw))
  registerHarness()
  Features.register(plan.features)
  for (const component of plan[role]) {
    const module: { registerWorker?: () => void; metadata?: { id: string; version: string; apiVersion: number } } =
      await import(component.entry)
    if (
      module.metadata?.id !== component.id ||
      module.metadata.version !== component.version ||
      module.metadata.apiVersion !== 1
    )
      throw new Error(`Worker component does not match the host composition: ${component.id}`)
    if (typeof module.registerWorker !== "function")
      throw new Error(`Worker component has no registrar: ${component.id}`)
    module.registerWorker()
  }
  RuntimeComponents.registerSelection(plan[role].map(({ id, version }) => ({ id, version, apiVersion: 1 })))
  ConfigExtensions.completeRegistration()
  ConfigExtensions.lock()
  RuntimeContext.sealComposition()
}
