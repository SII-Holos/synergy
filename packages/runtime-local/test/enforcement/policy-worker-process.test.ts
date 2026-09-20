import { afterAll, describe, expect, test } from "bun:test"
import { EnforcementGate, type GateOptions } from "@ericsanchezok/synergy-harness/enforcement/gate"
import {
  PolicyWorker,
  DEFAULT_POLICY_WORKER_POOL_OPTIONS,
  PolicyWorkerPool,
} from "@ericsanchezok/synergy-harness/enforcement/policy-worker"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("Local composition policy worker", () => {
  test("preserves classifier results across the process boundary", () =>
    runtime.run(async () => {
      const options: GateOptions = {
        activeWorkspace: import.meta.dir,
        workspaceType: "worktree",
        registeredMcpTools: new Set(["mcp__known__read"]),
      }
      const gate = await EnforcementGate.create(options)
      const pool = new PolicyWorkerPool({
        ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
        size: 1,
        timeoutMs: 3_000,
      })
      const cases = [
        { toolName: "bash", args: { command: "git push --force origin topic" } },
        { toolName: "read", args: { filePath: "/tmp/external.txt" } },
        { toolName: "mcp__known__read", args: {} },
        { toolName: "local__custom__tool", args: {} },
      ]

      try {
        for (const item of cases) {
          await expect(
            pool.run({
              context: PolicyWorker.context(options),
              toolName: item.toolName,
              args: item.args,
            }),
          ).resolves.toEqual(gate.classify(item.toolName, item.args))
        }
      } finally {
        await pool.stop()
      }
    }))
})

afterAll(() => runtime.close())
