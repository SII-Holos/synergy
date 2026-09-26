import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime()
      },
    },
  })
}
