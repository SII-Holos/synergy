import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { lattice } from "@ericsanchezok/synergy-lattice/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { anima } from "@ericsanchezok/synergy-anima/component"
export function workflowComponents() {
  return [agenda(), lightLoop(), blueprint(), lattice(), boss(), anima()]
}
