import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"

export function testRuntime(env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime()
      },
    },
  })
}
