import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
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
          provider: {
            options: {},
            timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
          },
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

function streamingSSEBody(totalBytes: number, chunkBytes: number, intervalMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let sent = 0
  let timer: ReturnType<typeof setInterval> | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (timer === undefined) return
        if (sent >= totalBytes) {
          clearInterval(timer)
          timer = undefined
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
          return
        }
        const size = Math.min(chunkBytes, totalBytes - sent)
        sent += size
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(size) } }] })}\n\n`),
        )
      }, intervalMs)
    },
    cancel() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  })
}

interface WindowWorker {
  send(message: AgentTurnProtocol.HostToWorker): void
  messages: AgentTurnProtocol.WorkerToHost[]
  waitFor(
    predicate: (message: AgentTurnProtocol.WorkerToHost) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<AgentTurnProtocol.WorkerToHost>
  stop(graceMs: number): Promise<void>
  exited: Promise<number | null>
}

function spawnWindowWorker(home: string): WindowWorker {
  const runnerPath = path.join(import.meta.dir, "../../src/session/agent-turn/runner.ts")
  const messages: AgentTurnProtocol.WorkerToHost[] = []
  const waiters: Array<{
    predicate: (message: AgentTurnProtocol.WorkerToHost) => boolean
    resolve: (message: AgentTurnProtocol.WorkerToHost) => void
    reject: (error: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  let stderrText = ""
  const child = Bun.spawn({
    cmd: [process.execPath, "run", runnerPath],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      SYNERGY_AGENT_WORKER: "1",
      SYNERGY_AGENT_PARENT_PID: String(process.pid),
      SYNERGY_HOME: home,
      SYNERGY_TEST_HOME: "",
    },
    ipc(message) {
      try {
        const parsed = AgentTurnProtocol.parseWorkerToHost(typeof message === "string" ? JSON.parse(message) : message)
        AgentTurnProtocol.assertIpcFrameBound(parsed)
        messages.push(parsed)
        for (let index = waiters.length - 1; index >= 0; index--) {
          const waiter = waiters[index]
          if (!waiter.predicate(parsed)) continue
          waiters.splice(index, 1)
          clearTimeout(waiter.timer)
          waiter.resolve(parsed)
        }
      } catch {
        child.kill()
      }
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  void new Response(child.stdout).text().catch(() => undefined)
  void new Response(child.stderr)
    .text()
    .then((text) => {
      stderrText = text
    })
    .catch(() => undefined)
  const waitFor: WindowWorker["waitFor"] = (predicate, label, timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
      const existing = messages.find(predicate)
      if (existing) {
        resolve(existing)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index !== -1) waiters.splice(index, 1)
        reject(
          new Error(
            `timed out waiting for ${label}; messages: ${messages.map((message) => message.type).join(",")}` +
              (stderrText ? `\nworker stderr:\n${stderrText.slice(-4_000)}` : ""),
          ),
        )
      }, timeoutMs)
      waiters.push({ predicate, resolve, reject, timer })
    })
  return {
    messages,
    send: (message) => {
      child.send(message)
    },
    waitFor,
    exited: child.exited,
    async stop(graceMs) {
      if (child.exitCode !== null) return
      try {
        child.send({ type: "shutdown" })
      } catch {
        child.kill()
        await child.exited.catch(() => undefined)
        return
      }
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ])
      if (!exited) child.kill()
      await child.exited.catch(() => undefined)
    },
  }
}

async function startWindowTurn(
  worker: WindowWorker,
  envelope: AgentTurnProtocol.TurnEnvelope,
  requestId: string,
): Promise<void> {
  const payload = AgentTurnProtocol.serializeTurn(envelope)
  const chunkCount = Math.ceil(payload.byteLength / AgentTurnProtocol.REQUEST_CHUNK_BYTES)
  worker.send({ type: "run-start", requestId, totalBytes: payload.byteLength, chunkCount })
  await worker.waitFor((message) => message.type === "run-ready" && message.requestId === requestId, "run-ready")
  for (let index = 0; index < chunkCount; index++) {
    const acknowledged = worker.waitFor(
      (message) => message.type === "chunk-ack" && message.requestId === requestId && message.index === index,
      `chunk-ack ${index}`,
    )
    const start = index * AgentTurnProtocol.REQUEST_CHUNK_BYTES
    worker.send({
      type: "run-chunk",
      requestId,
      index,
      data: payload.subarray(start, start + AgentTurnProtocol.REQUEST_CHUNK_BYTES),
    })
    await acknowledged
  }
  worker.send({ type: "run-commit", requestId })
  await worker.waitFor((message) => message.type === "started" && message.requestId === requestId, "started")
}

function streamingEnvelope(port: number): AgentTurnProtocol.TurnEnvelope {
  return {
    scope: Scope.home(),
    input: {
      user: { id: "msg_user" },
      sessionID: "ses_window_test",
      model: {
        id: "fake-model",
        providerID: "fake-local",
        api: { id: "fake-model", url: `http://127.0.0.1:${port}/v1`, npm: "@ai-sdk/openai-compatible" },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
        },
        limit: { context: 128_000, output: 32_000 },
        options: {},
      },
      agent: { name: "synergy" },
      system: [],
      messages: [{ role: "user", content: "stream a long response" }],
      toolDefinitions: [],
      prepared: {
        system: [],
        baseSystemLength: 0,
        provider: {
          options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
          timeouts: { ttfbMs: 5_000, idleMs: false, wallMs: false },
        },
        params: { options: {} },
      },
    },
  } as unknown as AgentTurnProtocol.TurnEnvelope
}

test(
  "runner pauses on the unacknowledged byte window, resumes on ack-window, and abort releases the waiter",
  async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-agent-window-"))
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(streamingSSEBody(1024 * 1024, 8 * 1024, 5), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const worker = spawnWindowWorker(home)
    const eventsOf = (requestId: string) =>
      worker.messages.filter(
        (message): message is Extract<AgentTurnProtocol.WorkerToHost, { type: "events" }> =>
          message.type === "events" && message.requestId === requestId,
      )
    const consumed = (requestId: string) =>
      eventsOf(requestId).reduce((total, message) => total + AgentTurnProtocol.byteLength(message), 0)
    try {
      await worker.waitFor((message) => message.type === "ready", "ready")

      const resumed = "turn_window_resume"
      await startWindowTurn(worker, streamingEnvelope(server.port!), resumed)
      await worker.waitFor(
        (message) => message.type === "events" && consumed(resumed) >= AgentTurnProtocol.ACK_WINDOW_BYTES,
        "first window crossing",
      )
      const framesAtPause = eventsOf(resumed).length
      await Bun.sleep(300)
      expect(eventsOf(resumed).length).toBe(framesAtPause)
      expect(worker.messages.some((message) => message.type === "complete" && message.requestId === resumed)).toBe(
        false,
      )

      worker.send({
        type: "ack-window",
        requestId: resumed,
        ackSequence: eventsOf(resumed).at(-1)!.sequence,
      })
      await worker.waitFor(
        (message) => message.type === "events" && consumed(resumed) >= AgentTurnProtocol.ACK_WINDOW_BYTES * 1.5,
        "resumed after ack",
      )
      worker.send({
        type: "ack-window",
        requestId: resumed,
        ackSequence: eventsOf(resumed).at(-1)!.sequence,
      })
      await worker.waitFor((message) => message.type === "complete" && message.requestId === resumed, "complete")
      await worker.waitFor((message) => message.type === "released" && message.requestId === resumed, "released")

      const aborted = "turn_window_abort"
      await startWindowTurn(worker, streamingEnvelope(server.port!), aborted)
      await worker.waitFor(
        (message) => message.type === "events" && consumed(aborted) >= AgentTurnProtocol.ACK_WINDOW_BYTES,
        "second window crossing",
      )
      const framesAtAbort = eventsOf(aborted).length
      await Bun.sleep(300)
      expect(eventsOf(aborted).length).toBe(framesAtAbort)
      expect(worker.messages.some((message) => message.type === "error" && message.requestId === aborted)).toBe(false)

      worker.send({ type: "cancel", requestId: aborted, reason: "test abort" })
      const terminal = (await worker.waitFor(
        (message) => message.type === "error" && message.requestId === aborted,
        "aborted turn error",
      )) as Extract<AgentTurnProtocol.WorkerToHost, { type: "error" }>
      expect(terminal.error.name).toBe("AbortError")
      await worker.waitFor(
        (message) => message.type === "released" && message.requestId === aborted,
        "released after abort",
      )
    } finally {
      await worker.stop(1_000)
      server.stop(true)
      await fs.rm(home, { recursive: true, force: true })
    }
    expect(await worker.exited).toBe(0)
  },
  { timeout: 20_000 },
)
