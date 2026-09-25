import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

export async function runCoreWorker(components: readonly RuntimeComponent[] = []): Promise<boolean> {
  const worker = process.argv.find((arg) =>
    [
      "__storage-worker-runner",
      "__owned-process-runner",
      "__observability-worker-runner",
      "__agent-turn-runner",
      "__policy-worker-runner",
      "__plugin-runtime-runner",
      "__storage-maintenance-runner",
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
    if (worker === "__storage-maintenance-runner") {
      const { createRuntimeCli } = await import("./runtime-cli")
      ;(await createRuntimeCli(components)).register!()
      const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
      await using handle = await StorageMaintenance.open({ recover: true })
      return true
    }
    const { Global } = await import("@ericsanchezok/synergy-harness/global")
    await Global.initialize({ cache: false })
    if (worker === "__plugin-runtime-runner") {
      const entry = process.argv[process.argv.indexOf(worker) + 1]
      if (!entry) throw new Error("Missing plugin runtime entry path")
      process.argv = [process.argv[0], process.argv[1], entry]
      await import("@ericsanchezok/synergy-plugin-host/plugin-runtime/runner")
    }
    if (worker === "__observability-worker-runner")
      await import("@ericsanchezok/synergy-harness/observability/telemetry-worker")
    if (worker === "__agent-turn-runner") {
      const { registerWorkerComponents } = await import("@ericsanchezok/synergy-agent-runtime/workers")
      await registerWorkerComponents("agent")
      const { startAgentWorker } = await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
      startAgentWorker()
    }
    if (worker === "__policy-worker-runner") {
      const { registerWorkerComponents } = await import("@ericsanchezok/synergy-agent-runtime/workers")
      await registerWorkerComponents("policy")
      const { startPolicyWorker } = await import("@ericsanchezok/synergy-harness/enforcement/policy-worker/runner")
      startPolicyWorker()
    }
    await new Promise(() => {})
    return true
  })
}

export async function main(components: readonly RuntimeComponent[] = []) {
  if (await runCoreWorker(components)) return
  const { runCli } = await import("./main")
  const { createRuntimeCli } = await import("./runtime-cli")
  await runCli(await createRuntimeCli(components))
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}
