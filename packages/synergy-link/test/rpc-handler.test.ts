import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RPCHandler } from "../src/rpc/handler"

const executionLease = {
  sessionID: "session_test",
  callerAgentID: "agent_test",
  callerOwnerUserID: 1,
}

describe("synergy-link rpc handler", () => {
  test("bash background execution returns process id", async () => {
    const handler = new RPCHandler({ linkID: "link_test" })
    const result = await handler.handle(
      {
        version: 2,
        requestID: "req_1",
        linkID: "link_test",
        tool: "bash",
        action: "execute",
        sessionID: "session_test",
        payload: {
          command: "echo hello && sleep 1",
          description: "background test",
          background: true,
        },
      },
      executionLease,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tool).toBe("bash")
    expect(result.action).toBe("execute")
    const metadata = result.result.metadata as { processId?: string; background?: boolean }
    expect(metadata.processId).toBeTruthy()
    expect(metadata.background).toBe(true)
  })

  test("reset waits for background process trees to terminate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-process-reset-"))
    const readyPath = path.join(root, "ready")
    const stoppedPath = path.join(root, "stopped")
    const workerPath = path.join(root, "worker.ts")
    const handler = new RPCHandler({ linkID: "link_test" })

    try {
      await Bun.write(
        workerPath,
        `process.on("SIGTERM", async () => {
  await Bun.sleep(300)
  await Bun.write(${JSON.stringify(stoppedPath)}, "stopped")
  process.exit(0)
})
await Bun.write(${JSON.stringify(readyPath)}, "ready")
setInterval(() => {}, 1_000)
`,
      )
      const result = await handler.handle(
        {
          version: 2,
          requestID: "req_reset",
          linkID: "link_test",
          tool: "bash",
          action: "execute",
          sessionID: "session_test",
          payload: {
            command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)}`,
            description: "reset cleanup test",
            workdir: root,
            background: true,
          },
        },
        executionLease,
      )
      expect(result.ok).toBe(true)

      for (let attempt = 0; attempt < 100 && !(await Bun.file(readyPath).exists()); attempt += 1) {
        await Bun.sleep(10)
      }
      expect(await Bun.file(readyPath).exists()).toBe(true)

      await handler.processRegistry.reset()

      expect(await Bun.file(stoppedPath).exists()).toBe(true)
    } finally {
      await handler.processRegistry.reset()
      await Bun.sleep(250)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("process list includes backgrounded process", async () => {
    const handler = new RPCHandler({ linkID: "link_test" })
    const started = await handler.handle(
      {
        version: 2,
        requestID: "req_2",
        linkID: "link_test",
        tool: "bash",
        action: "execute",
        sessionID: "session_test",
        payload: {
          command: "echo hello && sleep 1",
          description: "background test",
          background: true,
        },
      },
      executionLease,
    )

    expect(started.ok).toBe(true)
    if (!started.ok) return

    const listed = await handler.handle(
      {
        version: 2,
        requestID: "req_3",
        linkID: "link_test",
        tool: "process",
        action: "list",
        sessionID: "session_test",
        payload: { action: "list" },
      },
      executionLease,
    )

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.tool).toBe("process")
    expect(listed.action).toBe("list")
    const startedMetadata = started.result.metadata as { processId?: string }
    const listedMetadata = listed.result.metadata as { processes?: Array<{ processId: string }> }
    expect(listedMetadata.processes?.some((item) => item.processId === startedMetadata.processId)).toBe(true)
  })

  test("link mismatch returns error envelope", async () => {
    const handler = new RPCHandler({ linkID: "link_bound" })
    const result = await handler.handle(
      {
        version: 2,
        requestID: "req_4",
        linkID: "link_other",
        tool: "process",
        action: "list",
        sessionID: "session_test",
        payload: { action: "list" },
      },
      executionLease,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("link_not_found")
  })
  test("in-flight request survives capacity eviction and retry dedupes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-rpc-dedupe-"))
    const gatePath = path.join(root, "gate")
    const counterPath = path.join(root, "counter")
    const workerPath = path.join(root, "worker.ts")
    const handler = new RPCHandler({ linkID: "link_test" })

    try {
      await Bun.write(
        workerPath,
        `import { appendFile } from "node:fs/promises"
while (!(await Bun.file(${JSON.stringify(gatePath)}).exists())) {
  await Bun.sleep(50)
}
await appendFile(${JSON.stringify(counterPath)}, "executed\\n")
`,
      )

      const slowRequest = {
        version: 2,
        requestID: "req_slow",
        linkID: "link_test",
        tool: "bash",
        action: "execute",
        sessionID: "session_test",
        payload: {
          command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)}`,
          description: "dedupe eviction test",
        },
      }

      const inFlight = handler.handle(slowRequest, executionLease)

      for (let index = 0; index < 512; index += 1) {
        const filler = await handler.handle(
          {
            version: 2,
            requestID: `req_fill_${index}`,
            linkID: "link_test",
            tool: "process",
            action: "list",
            sessionID: "session_test",
            payload: { action: "list" },
          },
          executionLease,
        )
        expect(filler.ok).toBe(true)
      }

      const retried = handler.handle(slowRequest, executionLease)
      await Bun.write(gatePath, "go")

      const original = await inFlight
      const deduped = await retried
      expect(original.ok).toBe(true)
      expect(deduped).toBe(original)

      const counterText = (await Bun.file(counterPath).exists()) ? await Bun.file(counterPath).text() : ""
      const executions = counterText.split("\n").filter((line) => line === "executed")
      expect(executions).toHaveLength(1)
    } finally {
      await Bun.write(gatePath, "go")
      await handler.processRegistry.reset()
      await Bun.sleep(250)
      await rm(root, { recursive: true, force: true })
    }
  })
  test("rejects new unique requests while the dedupe cache is full of in-flight requests", async () => {
    const handler = new RPCHandler({ linkID: "link_test" })
    const execution = Promise.withResolvers<{
      title: string
      metadata: { action: "list"; processes: never[]; hostSessionID: string; linkID: string; backend: "remote" }
      output: string
    }>()
    const executeSpy = spyOn(handler.processRegistry, "execute").mockImplementation(async () => await execution.promise)
    const requests = Array.from({ length: 512 }, (_, index) => ({
      version: 2,
      requestID: `req_pending_${index}`,
      linkID: "link_test",
      tool: "process",
      action: "list",
      sessionID: "session_test",
      payload: { action: "list" },
    }))
    const pending = requests.map((request) => handler.handle(request, executionLease))

    try {
      const retried = handler.handle(requests[0], executionLease)
      const overloaded = await Promise.race([
        handler.handle({ ...requests[0], requestID: "req_over_capacity" }, executionLease),
        Bun.sleep(100).then(() => "timeout" as const),
      ])

      expect(overloaded).not.toBe("timeout")
      if (overloaded === "timeout") return
      expect(overloaded).toMatchObject({
        ok: false,
        error: {
          code: "execution_failed",
          details: { reason: "request_capacity_exhausted", retryable: true },
        },
      })
      expect(executeSpy).toHaveBeenCalledTimes(512)

      execution.resolve({
        title: "Process list",
        metadata: {
          action: "list",
          processes: [],
          hostSessionID: handler.host.hostSessionID,
          linkID: "link_test",
          backend: "remote",
        },
        output: "No running or recent processes.",
      })
      const [original, deduped] = await Promise.all([pending[0], retried])
      expect(deduped).toBe(original)
      await Promise.all(pending)
    } finally {
      execution.resolve({
        title: "Process list",
        metadata: {
          action: "list",
          processes: [],
          hostSessionID: handler.host.hostSessionID,
          linkID: "link_test",
          backend: "remote",
        },
        output: "No running or recent processes.",
      })
      executeSpy.mockRestore()
    }
  })
})
