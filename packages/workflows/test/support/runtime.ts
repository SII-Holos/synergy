import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { agendaBlueprint } from "@ericsanchezok/synergy-agenda-blueprint/component"
import { agendaLightLoop } from "@ericsanchezok/synergy-agenda-light-loop/component"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { workflowComponents } from "../../src/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { library } from "@ericsanchezok/synergy-library/component"
export function testRuntime(env?: Record<string, string | undefined>) {
  const components = [
    localRuntime({ workers: false, environment: false }),
    library(),
    note(),
    ...workflowComponents(),
    agendaBlueprint(),
    agendaLightLoop(),
  ]
  const composition = RuntimeComponents.compose(
    components,
    FeatureSelection.resolve(components, { optIn: ["boss", "lattice"] }),
  )
  return harnessRuntime({
    env,
    composition: {
      register() {
        composition.register()
      },
    },
  })
}
