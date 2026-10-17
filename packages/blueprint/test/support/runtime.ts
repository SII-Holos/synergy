import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { blueprint } from "../../src/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(env?: Record<string, string | undefined>, register?: () => void) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    note(),
    { ...blueprint(), register: registerWorker },
  ])
  return harnessRuntime({
    env,
    composition: {
      register() {
        composition.register()
        register?.()
      },
    },
  })
}
