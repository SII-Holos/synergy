import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { channels } from "../../src/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(
  options: { home?: string; register?: () => void; env?: Record<string, string | undefined> } = {},
) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    { ...channels(), register: registerWorker },
  ])
  return harnessRuntime({
    home: options.home,
    env: options.env,
    composition: {
      register() {
        composition.register()
        options.register?.()
      },
    },
  })
}
