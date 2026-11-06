import { z } from "zod"
export const WorkflowInfo = z.object({
  kind: z.literal("boss"),
  role: z.enum(["boss", "worker"]),
  workerRole: z.string().optional(),
  rootID: z.string().optional(),
  instructions: z.string().optional(),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    boss: WorkflowInfo
  }
}
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
export function registerSessionSchema() {
  SessionSchemaRegistry.register("boss", {
    shape: {},
    normalizeImport(input, mode) {
      if (
        mode !== "transcript" &&
        input.workflow &&
        typeof input.workflow === "object" &&
        "kind" in input.workflow &&
        input.workflow.kind === "boss"
      )
        input.workflow = undefined
    },
  })
}
