import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { agenda } from "../../src/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(env?: Record<string, string | undefined>) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    { ...agenda(), register: registerWorker },
  ])
  return harnessRuntime({
    env,
    composition: {
      register() {
        composition.register()
      },
    },
  })
}
