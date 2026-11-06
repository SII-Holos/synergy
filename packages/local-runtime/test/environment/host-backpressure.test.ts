import { expect, mock, spyOn, test } from "bun:test"
import type { Executor, ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { ExecutionHost } from "../../src/environment/host"

type SocketData = { id: string; cursor: number; closed: boolean; drain?: () => void }

test.each(["output", "status"])("a dropped duplex %s frame closes the stream and preserves replay", async (dropped) => {
  const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
  const chunk = { cursor: 1, stream: "stdout" as const, data: Buffer.from("retained output").toString("base64") }
  const status: ExecutionProtocol.Status = {
    id: "operation",
    target,
    digest: "0".repeat(64),
    state: "exited",
    exitCode: 0,
    cursor: 1,
    treeDrained: true,
    streamsDrained: true,
  }
  const executor: Executor = {
    start: async () => status,
    status: async () => status,
    output: async (_id, after) => (after < chunk.cursor ? [chunk] : []),
    stdin: async () => {},
    resize: async () => {},
    cancel: mock(async () => {}),
    release: mock(async () => {}),
  }
  const serve = spyOn(Bun, "serve")
  try {
    await using host = ExecutionHost.listen({
      target,
      executor,
      token: "test-token-with-at-least-thirty-two-bytes",
      listen: { hostname: "127.0.0.1", port: 0 },
    })
    const handler = (serve.mock.calls[0][0] as { websocket: Bun.WebSocketHandler<SocketData> }).websocket
    const sent = Promise.withResolvers<void>()
    const socket = {
      data: { id: status.id, cursor: 0, closed: false },
      send: mock((frame: string | Uint8Array) => {
        if ((typeof frame === "string") === (dropped === "status")) {
          sent.resolve()
          return 0
        }
        return 1
      }),
      close: mock((code: number, reason: string) => handler.close?.(socket, code, reason)),
    } as unknown as Bun.ServerWebSocket<SocketData>
    handler.open?.(socket)
    await sent.promise
    expect(socket.close).toHaveBeenCalledWith(1013, "Reconnect to resume execution output")
    expect(socket.data.closed).toBe(true)
    expect(socket.data.cursor).toBe(dropped === "output" ? 0 : 1)

    const replayed: (string | Uint8Array)[] = []
    const done = Promise.withResolvers<void>()
    const resumed = {
      data: { id: status.id, cursor: socket.data.cursor, closed: false },
      send(frame: string | Uint8Array) {
        replayed.push(frame)
        if (typeof frame === "string") done.resolve()
        return 1
      },
    } as Bun.ServerWebSocket<SocketData>
    handler.open?.(resumed)
    await done.promise
    expect(replayed.at(-1)).toBe(JSON.stringify({ type: "status", status }))
    if (dropped === "output") {
      const frame = Buffer.from(replayed[0] as Uint8Array)
      expect(frame.readDoubleBE(1)).toBe(1)
      expect(frame.subarray(9).toString()).toBe("retained output")
    }
    expect(executor.cancel).not.toHaveBeenCalled()
    expect(executor.release).not.toHaveBeenCalled()
  } finally {
    serve.mockRestore()
  }
})
