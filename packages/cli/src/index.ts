export async function runCoreWorker(): Promise<boolean> {
  const worker = process.argv.find((arg) =>
    ["__observability-worker-runner", "__agent-turn-runner", "__policy-worker-runner"].includes(arg),
  )
  if (!worker) return false
  const { Global } = await import("@ericsanchezok/synergy-harness/global")
  await Global.initialize({ cache: false })
  if (worker === "__observability-worker-runner")
    await import("@ericsanchezok/synergy-harness/observability/telemetry-worker")
  if (worker === "__agent-turn-runner") {
    const { registerLocalRuntime } = await import("@ericsanchezok/synergy-runtime-local/register")
    registerLocalRuntime()
    await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
  }
  if (worker === "__policy-worker-runner")
    await import("@ericsanchezok/synergy-harness/enforcement/policy-worker/runner")
  await new Promise(() => {})
  return true
}

export async function main() {
  if (await runCoreWorker()) return
  const { runCli } = await import("./main")
  await runCli({
    runtimeFactory: async (options) => (await import("@ericsanchezok/synergy-runtime-local")).openLocalRuntime(options),
    beforeCommand: async () => (await import("@ericsanchezok/synergy-runtime-local/register")).registerLocalRuntime(),
  })
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}
