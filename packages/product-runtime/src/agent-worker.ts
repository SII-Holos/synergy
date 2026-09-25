import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { registerProductRuntime } from "./product-registration"
import { startAgentWorker } from "@ericsanchezok/synergy-harness/session/agent-turn/runner"
RuntimeContext.create(createLocalHost()).run(() => {
  registerProductRuntime()
  startAgentWorker()
})
