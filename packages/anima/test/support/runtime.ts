import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { anima } from "../../src/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { registerWorker } from "../../src/worker"
export function testRuntime() {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    library(),
    note(),
    agenda(),
    { ...anima(), register: registerWorker },
  ])
  return harnessRuntime({
    composition: {
      register() {
        composition.register()
      },
    },
  })
}
