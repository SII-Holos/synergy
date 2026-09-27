import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"

export function testRuntime(env?: Record<string, string | undefined>, register?: () => void) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime()
        register?.()
      },
    },
  })
}
