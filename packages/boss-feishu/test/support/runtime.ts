import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { bossFeishu } from "../../src/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { channelFeishu } from "@ericsanchezok/synergy-channel-feishu/component"
import { registerWorker } from "../../src/worker"
export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  const components = [
    localRuntime({ workers: false, environment: false }),
    library(),
    agenda(),
    boss(),
    channels(),
    channelFeishu(),
    { ...bossFeishu(), register: registerWorker },
  ]
  const composition = RuntimeComponents.compose(components, FeatureSelection.resolve(components, { optIn: ["boss"] }))
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
