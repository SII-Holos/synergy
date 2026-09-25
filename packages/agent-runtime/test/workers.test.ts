import { expect, test } from "bun:test"
import { openAgentRuntime } from "../src"
import { lsp } from "@ericsanchezok/synergy-lsp/component"
import { spawnAgentWorkerProcess } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { spawnPolicyWorkerProcess } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerWorkerComponents } from "../src/workers"

test("real agent and policy workers start from the host's explicit component selection", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openAgentRuntime({ home: fixture.host.root, host: fixture.host, components: [lsp()] })
  await runtime.run(async () => {
    const plan = JSON.parse(RuntimeContext.current().host.env.SYNERGY_WORKER_COMPONENTS!)
    expect(plan.agent.map((entry: { id: string }) => entry.id)).toEqual(["local-runtime", "lsp", "plugin-host"])
    expect(plan.policy).toEqual([])
    for (const spawn of [spawnAgentWorkerProcess, spawnPolicyWorkerProcess]) {
      const ready = Promise.withResolvers<number>()
      const timer = setTimeout(() => ready.reject(new Error("Worker did not become ready")), 15_000)
      const worker = spawn({
        onMessage(message) {
          if (message.type === "ready") ready.resolve(message.pid)
        },
        onExit(code) {
          ready.reject(new Error(`Worker exited before readiness: ${code}`))
        },
      })
      try {
        expect(await ready.promise).toBe(worker.process.pid)
      } finally {
        clearTimeout(timer)
        await worker.stop(1000)
      }
    }
  })
}, 30_000)

test("worker entrypoints refuse to guess a composition without the owning host's plan", async () => {
  await using fixture = await runtimeHome()
  const context = RuntimeContext.create(fixture.host)
  try {
    await expect(context.run(() => registerWorkerComponents("agent"))).rejects.toThrow("pinned composition")
  } finally {
    context.dispose()
  }
})
