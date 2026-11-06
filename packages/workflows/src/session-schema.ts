import { z } from "zod"
import { WorkflowInfo as Plan } from "@ericsanchezok/synergy-blueprint/session-schema"
import { WorkflowInfo as LightLoop } from "@ericsanchezok/synergy-light-loop/session-schema"
import { WorkflowInfo as Lattice } from "@ericsanchezok/synergy-lattice/session-schema"
import { WorkflowInfo as Boss } from "@ericsanchezok/synergy-boss/session-schema"
export const WorkflowInfo = z.union([
  Plan,
  LightLoop,
  Lattice,
  Boss,
  z.object({
    kind: z.literal("extension"),
    extension: z.object({ kind: z.string().min(1), payload: z.unknown().optional() }),
  }),
])
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
export { SessionBlueprintPhase, SuperPlanSessionInfo } from "@ericsanchezok/synergy-blueprint/session-schema"
