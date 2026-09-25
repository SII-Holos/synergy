import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { loadHttpAdapters } from "@ericsanchezok/synergy-agent-runtime/adapters"
import { registerHttp } from "@ericsanchezok/synergy-server/http"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "../components"
import { sourceWebApp } from "./web-app"

const adapters = await loadHttpAdapters([plugins(), ...fullComponents()])
const state = RuntimeContext.state(() => ({ registered: false }))
export function registerFullRoutes() {
  if (state().registered) return
  registerHttp()
  for (const adapter of adapters) adapter.registerHttp()
  sourceWebApp().register()
  state().registered = true
}
