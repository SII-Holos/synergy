export async function runCoreWorker(): Promise<boolean> {
  const worker = process.argv.find((arg) =>
    [
      "__storage-worker-runner",
      "__owned-process-runner",
      "__observability-worker-runner",
      "__agent-turn-runner",
      "__policy-worker-runner",
    ].includes(arg),
  )
  if (!worker) return false
  if (worker === "__owned-process-runner") {
    const { runOwnedProcessWorker } = await import("@ericsanchezok/synergy-local-runtime/process/owned-worker")
    await runOwnedProcessWorker(process.argv[process.argv.indexOf(worker) + 1]!)
    return true
  }
  if (worker === "__storage-worker-runner") {
    await import("@ericsanchezok/synergy-harness/storage/sqlite-worker")
    await new Promise(() => {})
    return true
  }
  const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
  const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime/host")
  return RuntimeContext.create(createLocalHost()).run(async () => {
    const { Global } = await import("@ericsanchezok/synergy-harness/global")
    await Global.initialize({ cache: false })
    if (worker === "__observability-worker-runner")
      await import("@ericsanchezok/synergy-harness/observability/telemetry-worker")
    if (worker === "__agent-turn-runner") {
      const { registerLocalRuntime } = await import("@ericsanchezok/synergy-local-runtime/register")
      registerLocalRuntime()
      const { startAgentWorker } = await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
      startAgentWorker()
    }
    if (worker === "__policy-worker-runner") {
      const { registerLocalRuntime } = await import("@ericsanchezok/synergy-local-runtime/register")
      registerLocalRuntime()
      const { startPolicyWorker } = await import("@ericsanchezok/synergy-harness/enforcement/policy-worker/runner")
      startPolicyWorker()
    }
    await new Promise(() => {})
    return true
  })
}

export async function main() {
  if (await runCoreWorker()) return
  const { runCli } = await import("./main")
  await runCli({
    runtimeFactory: async (options) => (await import("@ericsanchezok/synergy-local-runtime")).openLocalRuntime(options),
    beforeCommand: async () => (await import("@ericsanchezok/synergy-local-runtime/register")).registerLocalRuntime(),
  })
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}
