import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "../../src/register"

export function testRuntime(options: { home?: string; env?: Record<string, string | undefined> } = {}) {
  return harnessRuntime({
    home: options.home,
    env: options.env,
    composition: {
      register() {
        registerLocalRuntime()
      },
    },
  })
}
