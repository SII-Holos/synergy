import { z } from "zod"
export const WorkflowInfo = z.object({
  kind: z.literal("lightloop"),
  instructions: z.string(),
  pluginOwner: z
    .object({
      pluginId: z.string(),
      pluginGeneration: z.string(),
      scopeId: z.string(),
      correlationId: z.string().optional(),
    })
    .optional(),
  deadlineAt: z.number().positive().optional(),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    lightloop: WorkflowInfo
  }
}
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
export function registerSessionSchema() {
  SessionSchemaRegistry.register("light-loop", {
    shape: {},
    normalizeImport(input, mode) {
      if (
        mode !== "transcript" &&
        input.workflow &&
        typeof input.workflow === "object" &&
        "kind" in input.workflow &&
        input.workflow.kind === "lightloop"
      )
        input.workflow = undefined
    },
  })
}
