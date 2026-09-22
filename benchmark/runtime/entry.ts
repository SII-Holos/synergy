import { loadComposition } from "./composition"
import { runCoreWorker } from "@ericsanchezok/synergy-cli/index"
import { runCli } from "@ericsanchezok/synergy-cli/main"

if (!(await runCoreWorker())) {
  const composition = await loadComposition(process.env.SYNERGY_BENCH_COMPOSITION ?? "core")
  await runCli({ runtimeFactory: composition.open, beforeCommand: async () => composition.register() })
  process.exit(process.exitCode ?? 0)
}
