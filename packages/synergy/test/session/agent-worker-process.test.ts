import { expect, test } from "bun:test"
import { spawnAgentWorkerProcess } from "../../src/session/agent-turn/process-host"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { Scope } from "../../src/scope"

test("Agent worker subprocess completes the IPC handshake and shuts down", async () => {
  let resolveReady!: () => void
  let resolvePong!: () => void
  let resolveRunReady!: () => void
  let resolveChunkAck: ((index: number) => void) | undefined
  let resolveTerminal!: (error: AgentTurnProtocol.SerializedError) => void
  let resolveReleased!: () => void
  let activeRequestID = "turn_transfer_test"
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const pong = new Promise<void>((resolve) => {
    resolvePong = resolve
  })
  const runReady = new Promise<void>((resolve) => {
    resolveRunReady = resolve
  })
  const terminal = new Promise<AgentTurnProtocol.SerializedError>((resolve) => {
    resolveTerminal = resolve
  })
  let released = new Promise<void>((resolve) => {
    resolveReleased = resolve
  })
  const worker = spawnAgentWorkerProcess({
    onMessage(message) {
      if (message.type === "ready") resolveReady()
      if (message.type === "pong") resolvePong()
      if (message.type === "run-ready") resolveRunReady()
      if (message.type === "chunk-ack") resolveChunkAck?.(message.index)
      if (message.type === "error" && message.requestId === activeRequestID) resolveTerminal(message.error)
      if (message.type === "released" && message.requestId === activeRequestID) resolveReleased()
    },
    onExit() {},
  })

  try {
    await Promise.race([
      ready,
      Bun.sleep(5_000).then(() => {
        throw new Error("Agent worker did not become ready")
      }),
    ])
    worker.send({ type: "ping" })
    await Promise.race([
      pong,
      Bun.sleep(5_000).then(() => {
        throw new Error("Agent worker did not answer ping")
      }),
    ])

    const payload = AgentTurnProtocol.serializeTurn({
      scope: Scope.home(),
      input: {
        user: { id: "msg_user" },
        sessionID: "ses_test",
        model: { id: "missing-model", providerID: "missing-provider" },
        agent: { name: "synergy" },
        system: ["x".repeat(AgentTurnProtocol.REQUEST_CHUNK_BYTES + 64)],
        messages: [],
        toolDefinitions: [],
        prepared: {
          system: [],
          baseSystemLength: 0,
          provider: { options: {} },
          params: { options: {} },
        },
      },
    })
    const chunkCount = Math.ceil(payload.byteLength / AgentTurnProtocol.REQUEST_CHUNK_BYTES)
    worker.send({
      type: "run-start",
      requestId: "turn_transfer_test",
      totalBytes: payload.byteLength,
      chunkCount,
    })
    await runReady
    for (let index = 0; index < chunkCount; index++) {
      const acknowledged = new Promise<number>((resolve) => {
        resolveChunkAck = resolve
      })
      const start = index * AgentTurnProtocol.REQUEST_CHUNK_BYTES
      worker.send({
        type: "run-chunk",
        requestId: "turn_transfer_test",
        index,
        data: payload.subarray(start, start + AgentTurnProtocol.REQUEST_CHUNK_BYTES),
      })
      expect(await acknowledged).toBe(index)
    }
    worker.send({ type: "run-commit", requestId: "turn_transfer_test" })
    const firstError = await Promise.race([
      terminal,
      Bun.sleep(5_000).then(() => {
        throw new Error("Agent worker did not terminate the transferred turn")
      }),
    ])
    expect(firstError.message).not.toContain('"time"')
    expect(firstError.message).not.toContain('"sandboxes"')
    expect(firstError.message).toContain("model.api.npm")
    await released

    activeRequestID = "turn_transfer_reuse_test"
    const secondRunReady = new Promise<void>((resolve) => {
      resolveRunReady = resolve
    })
    const secondTerminal = new Promise<AgentTurnProtocol.SerializedError>((resolve) => {
      resolveTerminal = resolve
    })
    released = new Promise<void>((resolve) => {
      resolveReleased = resolve
    })
    worker.send({
      type: "run-start",
      requestId: activeRequestID,
      totalBytes: payload.byteLength,
      chunkCount,
    })
    await secondRunReady
    for (let index = 0; index < chunkCount; index++) {
      const acknowledged = new Promise<number>((resolve) => {
        resolveChunkAck = resolve
      })
      const start = index * AgentTurnProtocol.REQUEST_CHUNK_BYTES
      worker.send({
        type: "run-chunk",
        requestId: activeRequestID,
        index,
        data: payload.subarray(start, start + AgentTurnProtocol.REQUEST_CHUNK_BYTES),
      })
      expect(await acknowledged).toBe(index)
    }
    worker.send({ type: "run-commit", requestId: activeRequestID })
    const secondError = await Promise.race([
      secondTerminal,
      Bun.sleep(5_000).then(() => {
        throw new Error("Agent worker was not reusable after a terminal turn")
      }),
    ])
    expect(secondError.message).not.toContain('"time"')
    expect(secondError.message).not.toContain('"sandboxes"')
    expect(secondError.message).toContain("model.api.npm")
    await released
  } finally {
    await worker.stop(1_000)
  }

  expect(await worker.process.exited).toBe(0)
})
