import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerRuntimeWorkers } from "@ericsanchezok/synergy-agent-runtime/workers"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "./components"

const components = RuntimeComponents.resolve([localRuntime({ workers: false }), plugins(), ...fullComponents()])
const composition = RuntimeComponents.compose(components)

export function registerFullPreset() {
  composition.register()
  ConfigExtensions.completeRegistration()
  registerRuntimeWorkers(components)
}
