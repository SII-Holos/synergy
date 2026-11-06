import { loadComposition } from "./composition"
import { runCoreWorker } from "@ericsanchezok/synergy-cli/index"
import { runCli } from "@ericsanchezok/synergy-cli/main"

if (!(await runCoreWorker())) {
  const composition = await loadComposition(process.env.SYNERGY_BENCH_COMPOSITION ?? "core")
  const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
  const { createLocalClient } = await import("@ericsanchezok/synergy-local-runtime/client")
  const { atomicJSON } = await import("./files")
  const argv = process.argv.slice(2)
  const sessionID = argv[0] === "send" ? Identifier.descending("session") : undefined
  await runCli({
    beforeCommand: async () => composition.register(),
    argv: sessionID ? [...argv, "--session", sessionID] : argv,
    runtimeFactory: async (options) => {
      const handle = await composition.open(options)
      try {
        if (sessionID) {
          const { data: session } = await createLocalClient(handle, {
            directory: process.env.SYNERGY_CWD || process.cwd(),
          }).session.create({
            id: sessionID,
            interaction: { mode: "unattended", source: "benchmark" },
            controlProfile: "full_access",
            workspace: { mode: "current" },
          })
          await atomicJSON("/logs/agent/unattended.json", {
            session_id: session.id,
            interaction: session.interaction,
          })
        }
      } catch (error) {
        await handle.close()
        throw error
      }
      return handle
    },
  })
  process.exit(process.exitCode ?? 0)
}
