import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerHarness, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

const Entry = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    entry: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "file:", "Worker entries must be local files"),
  })
  .strict()
const Plan = z.object({ apiVersion: z.literal(1), agent: z.array(Entry), policy: z.array(Entry) }).strict()
export type WorkerPlan = z.infer<typeof Plan>

export function workerPlan(components: readonly RuntimeComponent[]): WorkerPlan {
  const entries = (role: "agent" | "policy") =>
    components.flatMap((component) => {
      const entry = component.workers?.[role]
      return entry ? [{ id: component.id, version: component.version, entry: entry.href }] : []
    })
  return Plan.parse({ apiVersion: 1, agent: entries("agent"), policy: entries("policy") })
}

export async function registerWorkerComponents(role: "agent" | "policy") {
  const raw = RuntimeContext.current().host.env.SYNERGY_WORKER_COMPONENTS
  if (!raw) throw new Error("A component worker requires its host's pinned composition")
  const plan = Plan.parse(JSON.parse(raw))
  const seen = new Set<string>()
  for (const component of plan[role]) {
    if (seen.has(component.id)) throw new Error(`Duplicate worker component: ${component.id}`)
    seen.add(component.id)
  }
  registerHarness()
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
  ConfigExtensions.completeRegistration()
  ConfigExtensions.lock()
  RuntimeContext.sealComposition()
}
