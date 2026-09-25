import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { loadHttpAdapters } from "@ericsanchezok/synergy-agent-runtime/adapters"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "../components"

const adapters = await loadHttpAdapters([plugins(), ...fullComponents()])
const state = RuntimeContext.state(() => ({ registered: false }))
export function registerFullRoutes() {
  if (state().registered) return
  for (const adapter of adapters) adapter.registerHttp()
  state().registered = true
}
