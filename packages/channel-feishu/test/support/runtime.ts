import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { channelFeishu } from "../../src/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { registerWorker } from "../../src/worker"
import { registerPolicyWorkerEntrypoint } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"
export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    channels(),
    { ...channelFeishu(), register: registerWorker },
  ])
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        composition.register()
        registerPolicyWorkerEntrypoint(new URL("../../../harness/test/support/policy-worker.ts", import.meta.url))
        options.register?.()
      },
    },
  })
}
