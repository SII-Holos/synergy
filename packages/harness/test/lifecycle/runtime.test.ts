import { expect, test } from "bun:test"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { PolicyWorker } from "@ericsanchezok/synergy-harness/enforcement/policy-worker"
import { ToolScheduler } from "@ericsanchezok/synergy-harness/test/support/internals"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutPending } from "../../src/session/rollout/pending"
import type { RolloutSchema } from "../../src/session/rollout/schema"

function restoreAdmission() {
  SessionManager.openAdmission()
  AgentTurn.configure()
  PolicyWorker.configure()
  ToolScheduler.configure()
}

for (const fails of [false, true]) {
  test(`shutdown preserves pending recovery until transport stops (failure=${fails})`, async () => {
    const owner: RolloutSchema.Owner = { kind: "operation", scopeID: "test", operationID: crypto.randomUUID() }
    let ownersAtStop: RolloutSchema.Owner[] | undefined
    const runtime = await RuntimeHandle.open({
      mode: "oneshot",
      services: {
        transport: {
          closeAdmission() {},
          listen: () => ({
            async stop() {
              ownersAtStop = (await RolloutPending.tracked())?.owners
              if (fails) throw new Error("transport stop failed")
            },
          }),
        },
      },
    })
    try {
      await RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "pending" } })
      if (fails) await expect(runtime.close()).rejects.toThrow("Synergy runtime cleanup failed")
      else await runtime.close()
      expect(ownersAtStop).toContainEqual(owner)
      const pending = (await RolloutPending.tracked())?.owners
      if (fails) expect(pending).toContainEqual(owner)
      else expect(pending).toEqual([])
    } finally {
      await runtime.close().catch(() => {})
      restoreAdmission()
    }
  }, 30_000)
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
