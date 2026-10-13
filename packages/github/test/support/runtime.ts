import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { github } from "../../src/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    { ...github(), register: registerWorker },
  ])
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        composition.register()
        options.register?.()
      },
    },
  })
}
