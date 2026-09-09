import { expect, test } from "bun:test"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { PolicyWorker } from "@ericsanchezok/synergy-harness/enforcement/policy-worker"
import { ToolScheduler } from "@ericsanchezok/synergy-harness/test/support/internals"

function restoreAdmission() {
  SessionManager.openAdmission()
  AgentTurn.configure()
  PolicyWorker.configure()
  ToolScheduler.configure()
}

test("local runtime owns its home without a transport and releases it exactly once", async () => {
  const calls: string[] = []
  const runtime = await RuntimeHandle.open({
    mode: "oneshot",
    services: {
      initializeExtensions: async () => {
        calls.push("initialize")
      },
      disposeExtensions: async () => {
        calls.push("dispose")
      },
    },
  })
  try {
    expect(runtime.server).toBeUndefined()
    expect((await ServerProcessLock.read())?.mode).toBe("oneshot")
    await expect(RuntimeHandle.open({ mode: "oneshot" })).rejects.toThrow("already owns")
    await Promise.all([runtime.close(), runtime.close()])
    expect(calls).toEqual(["initialize", "dispose"])
    expect(await ServerProcessLock.read()).toBeUndefined()
  } finally {
    await runtime.close()
    restoreAdmission()
  }
}, 30_000)

test("startup failure disposes initialized resources and releases home ownership", async () => {
  const calls: string[] = []
  try {
    await expect(
      RuntimeHandle.open({
        mode: "oneshot",
        services: {
          initializeExtensions: async () => {
            throw new Error("extension initialization failed")
          },
          disposeExtensions: async () => {
            calls.push("dispose")
          },
        },
      }),
    ).rejects.toThrow("extension initialization failed")
    expect(calls).toEqual(["dispose"])
    expect(await ServerProcessLock.read()).toBeUndefined()
  } finally {
    restoreAdmission()
  }
}, 30_000)
