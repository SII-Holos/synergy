import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { connectionComponents } from "../../src/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
export function testRuntime(
  options: { register?: () => void; env?: Record<string, string | undefined>; environment?: boolean } = {},
) {
  const composition = RuntimeComponents.compose([
    localRuntime({ workers: false, environment: options.environment ?? false }),
    agenda(),
    ...connectionComponents(),
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
