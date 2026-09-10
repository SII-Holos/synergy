import { registerComposition } from "./register"

const composition = await registerComposition()
const { runCoreWorker } = await import("@ericsanchezok/synergy-cli/index")
if (!(await runCoreWorker())) {
  const { runCli } = await import("@ericsanchezok/synergy-cli/main")
  await runCli({
    runtimeFactory: async (options) => {
      const handle = await composition.open(options)
      const { registerAgentWorkerEntrypoint } = await import(
        "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
      )
      registerAgentWorkerEntrypoint(new URL("./worker.ts", import.meta.url))
      return handle
    },
  })
  process.exit(process.exitCode ?? 0)
}
