import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerSessionSchema } from "./session-schema"
import { registerBossTransferOwner } from "./transfer"

const state = RuntimeContext.state(() => ({ registered: false }))
export function registerMaintenance() {
  if (state().registered) return
  state().registered = true
  registerSessionSchema()
  registerBossTransferOwner()
}
