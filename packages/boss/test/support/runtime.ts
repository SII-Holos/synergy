import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { boss } from "../../src/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(
  env?: Record<string, string | undefined>,
  options: { environment?: boolean; traceClose?: boolean } = {},
) {
  const components = [
    localRuntime({ workers: false, environment: options.environment ?? false }),
    library(),
    agenda(),
    { ...boss(), register: registerWorker },
  ]
  const composition = RuntimeComponents.compose(components, FeatureSelection.resolve(components, { optIn: ["boss"] }))
  return harnessRuntime({
    env,
    traceClose: options.traceClose,
    composition: {
      register() {
        composition.register()
      },
    },
  })
}
