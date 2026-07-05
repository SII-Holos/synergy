import { describe, expect, test } from "bun:test"
import { RPCHandler } from "../src/rpc/handler"

describe("synergy-link rpc handler", () => {
  test("bash background execution returns process id", async () => {
    const handler = new RPCHandler({ linkID: "link_test" })
    const result = await handler.handle({
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
    const handler = new RPCHandler({ linkID: "link_test" })
    const started = await handler.handle({
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
    })

    expect(started.ok).toBe(true)
    if (!started.ok) return

    const listed = await handler.handle({
      version: 2,
      requestID: "req_3",
      linkID: "link_test",
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

  test("link mismatch returns error envelope", async () => {
    const handler = new RPCHandler({ linkID: "link_bound" })
    const result = await handler.handle({
      version: 2,
      requestID: "req_4",
      linkID: "link_other",
      tool: "process",
      action: "list",
      sessionID: "session_test",
      payload: { action: "list" },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("link_not_found")
  })
})
