import { z } from "zod"
export const WorkflowInfo = z.object({
  kind: z.literal("lattice"),
  runID: z.string(),
  mode: z.enum(["auto", "collaborative"]),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    lattice: WorkflowInfo
  }
}
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
export function registerSessionSchema() {
  SessionSchemaRegistry.register("lattice", {
    shape: {},
    normalizeImport(input, mode) {
      if (
        mode !== "transcript" &&
        input.workflow &&
        typeof input.workflow === "object" &&
        "kind" in input.workflow &&
        input.workflow.kind === "lattice"
      )
        input.workflow = undefined
    },
  })
}
