import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerWorker } from "@ericsanchezok/synergy-channels/worker"
export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        registerLocalRuntime()
        registerWorker()
        options.register?.()
      },
    },
  })
}
