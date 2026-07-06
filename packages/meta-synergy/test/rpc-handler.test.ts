import { describe, expect, test } from "bun:test"
import { RPCHandler } from "../src/rpc/handler.js"

function sleepCommand(ms: number) {
  return `bun test/fixture/sleep.js ${ms}`
}

describe("meta-synergy rpc handler", () => {
  test("bash auto-background execution returns process id", async () => {
    const handler = new RPCHandler({ envID: "env_test" })
    const result = await handler.handle({
      version: 1,
      requestID: "req_1",
      envID: "env_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: sleepCommand(1000),
        description: "background test",
        backgroundAfterSeconds: 0.05,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tool).toBe("bash")
    expect(result.action).toBe("execute")
    const metadata = result.result.metadata as { processId?: string; background?: boolean }
    expect(metadata.processId).toBeTruthy()
    expect(metadata.background).toBe(true)
  })

  test("process list includes backgrounded process", async () => {
    const handler = new RPCHandler({ envID: "env_test" })
    const started = await handler.handle({
      version: 1,
      requestID: "req_2",
      envID: "env_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: sleepCommand(1000),
        description: "background test",
        backgroundAfterSeconds: 0.05,
      },
    })

    expect(started.ok).toBe(true)
    if (!started.ok) return

    const listed = await handler.handle({
      version: 1,
      requestID: "req_3",
      envID: "env_test",
      tool: "process",
      action: "list",
      sessionID: "session_test",
      payload: { action: "list" },
    })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.tool).toBe("process")
    expect(listed.action).toBe("list")
    const startedMetadata = started.result.metadata as { processId?: string }
    const listedMetadata = listed.result.metadata as { processes?: Array<{ processId: string }> }
    expect(listedMetadata.processes?.some((item) => item.processId === startedMetadata.processId)).toBe(true)
  })

  test("bash auto-backgrounds after backgroundAfterSeconds", async () => {
    const handler = new RPCHandler({ envID: "env_test" })
    const result = await handler.handle({
      version: 1,
      requestID: "req_auto_background",
      envID: "env_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: sleepCommand(1000),
        description: "auto background test",
        backgroundAfterSeconds: 0.05,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.output).toContain("Command auto-backgrounded after 0.05s")
    const metadata = result.result.metadata as { processId?: string; background?: boolean }
    expect(metadata.processId).toBeTruthy()
    expect(metadata.background).toBe(true)
  })

  test("bash timeoutSeconds kills foreground command", async () => {
    const handler = new RPCHandler({ envID: "env_test" })
    const result = await handler.handle({
      version: 1,
      requestID: "req_timeout_foreground",
      envID: "env_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: sleepCommand(1000),
        description: "timeout foreground test",
        backgroundAfterSeconds: 1,
        timeoutSeconds: 0.05,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.output).toContain("command timed out after 0.05s")
  })

  test("bash timeoutSeconds kills backgrounded command", async () => {
    const handler = new RPCHandler({ envID: "env_test" })
    const started = await handler.handle({
      version: 1,
      requestID: "req_timeout_background_start",
      envID: "env_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: sleepCommand(1000),
        description: "timeout background test",
        backgroundAfterSeconds: 0.05,
        timeoutSeconds: 0.1,
      },
    })

    expect(started.ok).toBe(true)
    if (!started.ok) return
    const metadata = started.result.metadata as { processId?: string; background?: boolean }
    expect(metadata.background).toBe(true)
    expect(metadata.processId).toBeTruthy()
    const polled = await handler.handle({
      version: 1,
      requestID: "req_timeout_background_poll",
      envID: "env_test",
      tool: "process",
      action: "poll",
      sessionID: "session_test",
      payload: { action: "poll", processId: metadata.processId, block: true, timeout: 2 },
    })

    expect(polled.ok).toBe(true)
    if (!polled.ok) return
    expect(polled.result.output).toContain("command timed out after 0.1s")
    expect((polled.result.metadata as { status?: string }).status).toBe("killed")
  })

  test("env mismatch returns error envelope", async () => {
    const handler = new RPCHandler({ envID: "env_bound" })
    const result = await handler.handle({
      version: 1,
      requestID: "req_4",
      envID: "env_other",
      tool: "process",
      action: "list",
      sessionID: "session_test",
      payload: { action: "list" },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.tool).toBe("process")
    expect(result.action).toBe("list")
    expect(result.error.code).toBe("host_internal_error")
  })
})
