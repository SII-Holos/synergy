import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLibrary } from "../../src/register"
import { disposeLibrary } from "../../src/register"

export function testRuntime(env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLibrary()
      },
      services: () => ({ disposeExtensions: disposeLibrary }),
    },
  })
}
