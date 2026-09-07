import { Experiment } from "../../src/config/experiment"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "../../src/session/agent-turn/worker-pool"
import { GlobalBus } from "../../src/bus/global"
import { expect, test } from "bun:test"
import { RuntimeHandle } from "../../src/server/runtime-handle"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { ScopeStartup } from "../../src/scope/startup"
import { SessionManager } from "../../src/session/manager"
import { AgentTurn } from "../../src/session/agent-turn"
import { PolicyWorker } from "../../src/enforcement/policy-worker"
import { ToolScheduler } from "../../src/session/tool-scheduler"

test("one-shot owns its Home, omits autonomous recovery, and awaits idempotent shutdown", async () => {
  const initialListeners = GlobalBus.listenerCount("event")
  const runtime = await RuntimeHandle.open({ mode: "oneshot", network: { hostname: "127.0.0.1", port: 0 } })
  try {
    expect((await ServerProcessLock.read())?.mode).toBe("oneshot")
    expect(ScopeStartup.resident()).toBe(false)
    expect(runtime.config.execution?.agentWorkers).toBe(DEFAULT_AGENT_WORKER_POOL_OPTIONS.size)
    expect(() =>
      Experiment.assertRuntime({ execution: { agentWorkers: DEFAULT_AGENT_WORKER_POOL_OPTIONS.size } }),
    ).not.toThrow()
    await expect(RuntimeHandle.open({ mode: "oneshot", network: { hostname: "127.0.0.1", port: 0 } })).rejects.toThrow(
      "already owns",
    )
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
