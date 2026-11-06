import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { startAgentWorker } from "@ericsanchezok/synergy-harness/session/agent-turn/runner"
import { registerWorkerComponents } from "./workers"

await RuntimeContext.create(createLocalHost()).run(async () => {
  await registerWorkerComponents("agent")
  startAgentWorker()
})
