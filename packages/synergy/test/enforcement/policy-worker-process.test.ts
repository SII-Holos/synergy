import { describe, expect, test } from "bun:test"
import { EnforcementGate, type GateOptions } from "@/enforcement/gate"
import { PolicyWorker } from "@/enforcement/policy-worker"
import { PolicyWorkerProtocol } from "@/enforcement/policy-worker/protocol"
import { spawnPolicyWorkerProcess } from "@/enforcement/policy-worker/process-host"
import { DEFAULT_POLICY_WORKER_POOL_OPTIONS, PolicyWorkerPool } from "@/enforcement/policy-worker/worker-pool"

describe("Policy worker process", () => {
  test("classifies in a distinct process through the bounded protocol", async () => {
    const requestId = "policy_process_test"
    const payload = PolicyWorkerProtocol.serializeInput({
      context: {
        activeWorkspace: import.meta.dir,
        workspaceType: "worktree",
        registeredMcpTools: [],
        registeredPluginTools: [],
        pluginToolCapabilities: {},
      },
      toolName: "bash",
      args: { command: "ls |& cat" },
    })

    let workerPid: number | undefined
    let chunkIndex = 0
    let settled = false
    let resolveResult!: (value: PolicyWorkerProtocol.WorkerToHost) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<PolicyWorkerProtocol.WorkerToHost>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    const worker = spawnPolicyWorkerProcess({
      onMessage(message) {
        if (message.type === "ready") {
          workerPid = message.pid
          worker.send({
            type: "run-start",
            requestId,
            totalBytes: payload.byteLength,
            chunkCount: Math.ceil(payload.byteLength / PolicyWorkerProtocol.REQUEST_CHUNK_BYTES),
          })
          return
        }
        if (message.type === "run-ready" || message.type === "chunk-ack") {
          const start = chunkIndex * PolicyWorkerProtocol.REQUEST_CHUNK_BYTES
          if (start < payload.byteLength) {
            const index = chunkIndex++
            worker.send({
              type: "run-chunk",
              requestId,
              index,
              data: payload.subarray(start, start + PolicyWorkerProtocol.REQUEST_CHUNK_BYTES),
            })
          } else {
            worker.send({ type: "run-commit", requestId })
          }
          return
        }
        if (message.type === "result" || message.type === "error") {
          settled = true
          resolveResult(message)
        }
      },
      onExit(exitCode, signal) {
        if (!settled) rejectResult(new Error(`Policy worker exited (${exitCode ?? signal ?? "unknown"})`))
      },
    })

    try {
      const message = await Promise.race([
        result,
        Bun.sleep(3_000).then(() => {
          throw new Error("Policy worker process did not respond")
        }),
      ])
      expect(workerPid).toBeNumber()
      expect(workerPid).not.toBe(process.pid)
      expect(message).toMatchObject({
        type: "result",
        result: { capabilities: [{ class: "shell_read", nonBypassable: false }] },
      })
    } finally {
      settled = true
      await worker.stop(100)
    }
  })

  test("preserves classifier results across the process boundary", async () => {
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
  })
})
