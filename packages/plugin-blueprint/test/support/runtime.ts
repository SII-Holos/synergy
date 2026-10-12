import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { pluginBlueprint } from "../../src/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { registerWorker } from "../../src/worker"
export function testRuntime() {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    note(),
    blueprint(),
    plugins(),
    { ...pluginBlueprint(), register: registerWorker },
  ])
  return harnessRuntime({
    composition: {
      register() {
        composition.register()
      },
    },
  })
}
