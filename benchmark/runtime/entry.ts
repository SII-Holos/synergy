import { registerComposition } from "./register"

const composition = await registerComposition()
const { runCoreWorker } = await import("@ericsanchezok/synergy-cli/index")
if (!(await runCoreWorker())) {
  const { runCli } = await import("@ericsanchezok/synergy-cli/main")
  const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
  const { withScopeContext } = await import("@ericsanchezok/synergy-cli/cli/scope")
  const { createLocalClient } = await import("@ericsanchezok/synergy-runtime-local/client")
  const { atomicJSON } = await import("./files")
  const argv = process.argv.slice(2)
  const sessionID = argv[0] === "send" ? Identifier.descending("session") : undefined
  await runCli({
    argv: sessionID ? [...argv, "--session", sessionID] : argv,
    runtimeFactory: async (options) => {
      const handle = await composition.open(options)
      if (sessionID) {
        await withScopeContext(process.env.SYNERGY_CWD || process.cwd(), async () => {
          const { data: session } = await createLocalClient().session.create({
            id: sessionID,
            interaction: { mode: "unattended", source: "benchmark" },
            controlProfile: "full_access",
            workspace: { mode: "current" },
          })
          await atomicJSON("/logs/agent/unattended.json", {
            session_id: session.id,
            interaction: session.interaction,
          })
        })
      }
      const { registerAgentWorkerEntrypoint } = await import(
        "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
      )
      registerAgentWorkerEntrypoint(new URL("./worker.ts", import.meta.url))
      return handle
    },
  })
  process.exit(process.exitCode ?? 0)
}
