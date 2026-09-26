import { loadComposition } from "./composition"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-runtime-local"
import { startAgentWorker } from "@ericsanchezok/synergy-harness/session/agent-turn/runner"

const composition = await loadComposition(process.env.SYNERGY_BENCH_COMPOSITION ?? "core")
RuntimeContext.create(createLocalHost()).run(() => {
  composition.register()
  startAgentWorker()
})
