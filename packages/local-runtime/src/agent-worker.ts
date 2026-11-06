import { registerLocalRuntime } from "./register"
import { createLocalHost } from "./host"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

await RuntimeContext.create(createLocalHost()).run(async () => {
  registerLocalRuntime()
  const { startAgentWorker } = await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
  startAgentWorker()
})
