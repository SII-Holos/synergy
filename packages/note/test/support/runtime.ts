import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerNote } from "../../src/register"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        registerNote()
      },
    },
  })
}
