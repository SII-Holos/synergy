import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

export async function runComponentRunner(entry: URL, name: string) {
  const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
  const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime/host")
  const context = RuntimeContext.create(createLocalHost())
  try {
    await context.run(async () => {
      const { Global } = await import("@ericsanchezok/synergy-harness/global")
      await Global.initialize({ cache: false })
      const module: Record<string, unknown> = await import(entry.href)
      if (typeof module[name] !== "function") throw new Error(`Component runner export is missing: ${name}`)
      await module[name]()
    })
  } finally {
    context.dispose()
  }
}

export async function runCoreWorker(
  components: readonly RuntimeComponent[] = [],
  ready?: () => void,
): Promise<boolean> {
  const { CORE_RUNNERS } = await import("@ericsanchezok/synergy-util/installed-launcher")
  const worker = process.argv[2]
  if (!CORE_RUNNERS.some((name) => worker === `__${name}`)) return false
  if (worker === "__owned-process-runner") {
    const { runOwnedProcessWorker } = await import("@ericsanchezok/synergy-local-runtime/process/owned-worker")
    await runOwnedProcessWorker(process.argv[process.argv.indexOf(worker) + 1]!)
    return true
  }
  if (worker === "__storage-worker-runner") {
    await import("@ericsanchezok/synergy-harness/storage/sqlite-worker")
    ready?.()
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
    ready?.()
    await new Promise(() => {})
    return true
  })
}

export async function main(components: readonly RuntimeComponent[] = [], workerReady?: () => void) {
  if (await runCoreWorker(components, workerReady)) return
  const { runCli } = await import("./main")
  const { createRuntimeCli } = await import("./runtime-cli")
  await runCli(await createRuntimeCli(components))
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}
