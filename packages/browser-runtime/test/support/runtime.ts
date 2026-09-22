import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerBrowser } from "../../src/register"
import { disposeBrowser } from "../../src/register"

export function testRuntime(register?: () => void, env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerBrowser()
        register?.()
      },
      services: () => ({ disposeExtensions: disposeBrowser }),
    },
  })
}
