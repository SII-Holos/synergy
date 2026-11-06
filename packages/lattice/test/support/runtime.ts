import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { lattice } from "../../src/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(env?: Record<string, string | undefined>) {
  const components = [
    localRuntime({ workers: false, environment: false }),
    note(),
    blueprint(),
    { ...lattice(), register: registerWorker },
  ]
  const composition = RuntimeComponents.compose(
    components,
    FeatureSelection.resolve(components, { optIn: ["lattice"] }),
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
