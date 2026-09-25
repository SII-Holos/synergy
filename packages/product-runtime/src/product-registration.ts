import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "./components"

const composition = RuntimeComponents.compose([localRuntime(), plugins(), ...fullComponents()])

export function registerProductRuntime() {
  composition.register()
  ConfigExtensions.completeRegistration()
  registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))
}
