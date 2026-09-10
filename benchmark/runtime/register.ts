import { loadComposition } from "./composition"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"

export async function registerComposition() {
  const composition = await loadComposition(process.env.SYNERGY_BENCH_COMPOSITION ?? "core")
  await composition.register()
  registerAgentWorkerEntrypoint(new URL("./worker.ts", import.meta.url))
  return composition
}
