import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { channelClarus } from "../../src/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { holos } from "@ericsanchezok/synergy-holos/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    channels(),
    holos(),
    agenda(),
    { ...channelClarus(), register: registerWorker },
  ])
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        composition.register()
        options.register?.()
      },
    },
  })
}
