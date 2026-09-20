import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "../../src/register"

export function testRuntime(options: { env?: Record<string, string | undefined> } = {}) {
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        registerLocalRuntime()
      },
    },
  })
}
