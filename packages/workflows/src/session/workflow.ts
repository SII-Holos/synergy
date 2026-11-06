import { SessionWorkflowService as Core } from "@ericsanchezok/synergy-harness/session/workflow"
import { WorkflowSessionService as Blueprint } from "@ericsanchezok/synergy-blueprint/session/workflow"
import { WorkflowSessionService as LightLoop } from "@ericsanchezok/synergy-light-loop/session/workflow"
import { WorkflowSessionService as Lattice } from "@ericsanchezok/synergy-lattice/session/workflow"
import { WorkflowSessionService as Boss } from "@ericsanchezok/synergy-boss/session/workflow"
export { WorkflowConflictError } from "@ericsanchezok/synergy-harness/session/workflow"
export const WorkflowSessionService = { ...Core, ...Blueprint, ...LightLoop, ...Lattice, ...Boss }
