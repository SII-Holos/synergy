import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "@ericsanchezok/synergy-harness/session/agent-turn/worker-pool"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { expect, test } from "bun:test"
import { ProductRuntimeHandle } from "@ericsanchezok/synergy-product-runtime/server/runtime-handle"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { PolicyWorker } from "@ericsanchezok/synergy-harness/enforcement/policy-worker"
import { ToolScheduler } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"

test("one-shot owns its Home, omits autonomous recovery, and awaits idempotent shutdown", async () => {
  const initialListeners = GlobalBus.listenerCount("event")
  const recovery: Array<number | "completed"> = []
  const runtime = await ProductRuntimeHandle.open({
    mode: "oneshot",
    storage: Storage.current(),
    network: { hostname: "127.0.0.1", port: 0 },
    recoveryReporter: {
      progress: (current) => recovery.push(current),
      completed: () => recovery.push("completed"),
    },
  })
  try {
    expect(recovery[0]).toBe(0)
    expect(recovery.at(-1)).toBe("completed")
    expect((await ServerProcessLock.read())?.mode).toBe("oneshot")
    expect(ScopeStartup.resident()).toBe(false)
    expect(runtime.config.execution?.agentWorkers).toBe(DEFAULT_AGENT_WORKER_POOL_OPTIONS.size)
    expect(() =>
      Experiment.assertRuntime({ execution: { agentWorkers: DEFAULT_AGENT_WORKER_POOL_OPTIONS.size } }),
    ).not.toThrow()
    await expect(
      ProductRuntimeHandle.open({ mode: "oneshot", network: { hostname: "127.0.0.1", port: 0 } }),
    ).rejects.toThrow("already owns")
    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
    expect(response.ok).toBe(true)
    await Promise.all([runtime.close(), runtime.close()])
    expect(await ServerProcessLock.read()).toBeUndefined()
    expect(GlobalBus.listenerCount("event")).toBeLessThanOrEqual(initialListeners)
  } finally {
    await runtime.close()
    SessionManager.openAdmission()
    AgentTurn.configure()
    PolicyWorker.configure()
    ToolScheduler.configure()
  }
}, 30_000)

test("failed recovery does not announce completion or retain home ownership", async () => {
  const root = ["operations", "test", crypto.randomUUID(), "rollout", "journal"]
  const event = [...root, "events", "000000000001"]
  const recovery: Array<number | "completed"> = []
  await Storage.write([...root, "head"], { allocated: 1, committed: 1 })
  await Storage.write(event, { version: 1, seq: 2, time: 0, kind: "gap" })
  // Simulate an unknown pending ledger so recovery falls back to the
  // exhaustive scan that discovers this hand-written journal.
  await Storage.remove(StoragePath.rolloutRecoveryPending())
  try {
    await expect(
      ProductRuntimeHandle.open({
        mode: "oneshot",
        storage: Storage.current(),
        recoveryReporter: {
          progress: (current) => recovery.push(current),
          completed: () => recovery.push("completed"),
        },
      }),
    ).rejects.toThrow()
    expect(recovery[0]).toBe(0)
    expect(recovery).not.toContain("completed")
    expect(await ServerProcessLock.read()).toBeUndefined()
  } finally {
    await Storage.remove(event)
    await Storage.remove([...root, "head"])
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    SessionManager.openAdmission()
    AgentTurn.configure()
    PolicyWorker.configure()
    ToolScheduler.configure()
  }
}, 30_000)
