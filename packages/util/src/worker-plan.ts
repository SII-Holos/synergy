import { z } from "zod"
import { FeaturePlan } from "./features"

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

export const ComponentWorkerPlan = z
  .object({ apiVersion: z.literal(2), agent: z.array(Entry), policy: z.array(Entry), features: FeaturePlan })
  .strict()
  .superRefine((plan, context) => {
    const versions = new Map(plan.features.selection.map(({ id, version }) => [id, version]))
    for (const role of ["agent", "policy"] as const) {
      const seen = new Set<string>()
      for (const entry of plan[role]) {
        const message = seen.has(entry.id)
          ? `Duplicate worker component: ${entry.id}`
          : !plan.features.components.includes(entry.id)
            ? `Worker component is not in its host feature plan: ${entry.id}`
            : versions.get(entry.id) !== entry.version
              ? `Worker component does not match the host composition: ${entry.id}`
              : undefined
        if (message) context.addIssue({ code: "custom", path: [role], message })
        seen.add(entry.id)
      }
    }
  })
export type ComponentWorkerPlan = z.infer<typeof ComponentWorkerPlan>
