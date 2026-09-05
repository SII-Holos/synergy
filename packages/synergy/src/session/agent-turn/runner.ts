import type { ModelMessage, Tool as AITool } from "ai"
import { ScopeContext } from "@/scope/context"
import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import { watchManagedParent } from "@/util/managed-parent"
import { AgentTurnProtocol } from "./protocol"
import { AgentStreamEventCoalescer } from "./stream-event-coalescer"
import type { AgentTurnWorkerInput } from "./worker-pool"
import { clearReplayPlan } from "@/provider/codex-compaction"

type AgentSDKStreamPart = LLM.StreamOutput["fullStream"] extends AsyncIterable<infer Part> ? Part : never

interface ActiveTurn {
  requestId: string
  controller: AbortController
  windowWaiter: (() => void) | undefined
  unackedBytes: number
  // Per-frame byte weights keyed by sequence, retained until the host
  // acknowledges them so partial ack-windows only credit covered frames.
  unackedFrames: Array<{ sequence: number; bytes: number }>
}

let active: ActiveTurn | undefined
let pending:
  | {
      requestId: string
      totalBytes: number
      chunkCount: number
      chunks: Uint8Array[]
      receivedBytes: number
    }
  | undefined
let turns = 0
let shuttingDown = false
let sequence = 0
let idleSampleTimer: ReturnType<typeof setTimeout> | undefined
const IDLE_SAMPLE_DELAY_MS = 1_000

function send(message: AgentTurnProtocol.WorkerToHost): void {
  AgentTurnProtocol.assertIpcFrameBound(message)
  process.send?.(message)
}

function memory() {
  const usage = process.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  }
}

function release(requestId: string): void {
  const collection = process.platform === "linux" ? "full" : "none"
  if (collection === "full") Bun.gc(true)
  send({
    type: "released",
    requestId,
    turns,
    collection,
    memory: memory(),
  })
  if (idleSampleTimer) clearTimeout(idleSampleTimer)
  idleSampleTimer = setTimeout(() => {
    idleSampleTimer = undefined
    send({
      type: "heartbeat",
      requestId: active?.requestId,
      turns,
      collection: "none",
      memory: memory(),
    })
  }, IDLE_SAMPLE_DELAY_MS)
  idleSampleTimer.unref()
}

function rejectAndRelease(requestId: string, error: unknown): void {
  send({
    type: "error",
    requestId,
    error: AgentTurnProtocol.serializeError(error),
  })
  queueMicrotask(() => release(requestId))
}

function reject(requestId: string, error: unknown): void {
  send({
    type: "error",
    requestId,
    error: AgentTurnProtocol.serializeError(error),
  })
}

function waitForAckWindow(turn: ActiveTurn): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (turn.controller.signal.aborted) {
      reject(turn.controller.signal.reason)
      return
    }
    const onAbort = () => {
      turn.windowWaiter = undefined
      reject(turn.controller.signal.reason)
    }
    turn.controller.signal.addEventListener("abort", onAbort, { once: true })
    turn.windowWaiter = () => {
      turn.controller.signal.removeEventListener("abort", onAbort)
      resolve()
    }
  })
}

async function sendEvents(turn: ActiveTurn, events: AgentSDKStreamPart[]): Promise<void> {
  if (events.length === 0) return
  const frame = {
    type: "events" as const,
    requestId: turn.requestId,
    sequence: ++sequence,
    events: AgentTurnProtocol.encodeEvents(events),
  }
  AgentTurnProtocol.assertEventFrameBound(frame)
  const bytes = AgentTurnProtocol.byteLength(frame)
  send(frame)
  turn.unackedFrames.push({ sequence: frame.sequence, bytes })
  turn.unackedBytes += bytes
  if (turn.unackedBytes >= AgentTurnProtocol.ACK_WINDOW_BYTES) {
    await waitForAckWindow(turn)
  }
}

async function streamEvents(turn: ActiveTurn, stream: AsyncIterable<AgentSDKStreamPart>): Promise<void> {
  const coalescer = new AgentStreamEventCoalescer<AgentSDKStreamPart>()
  for await (const value of stream) {
    turn.controller.signal.throwIfAborted()
    await sendEvents(turn, coalescer.push(value))
  }
  await sendEvents(turn, coalescer.flush())
}

type Terminal =
  | {
      type: "complete"
      requestId: string
      turns: number
      usage?: unknown
      memoryBeforeDispose: AgentTurnProtocol.WorkerMemory
      memory: AgentTurnProtocol.WorkerMemory
    }
  | {
      type: "error"
      requestId: string
      error: AgentTurnProtocol.SerializedError
      memoryBeforeDispose: AgentTurnProtocol.WorkerMemory
      memory: AgentTurnProtocol.WorkerMemory
    }

async function executeTurn(turn: ActiveTurn, envelope: AgentTurnProtocol.TurnEnvelope): Promise<Terminal> {
  const input = envelope.input as unknown as AgentTurnWorkerInput
  let ownedStream: ReturnType<typeof LLM.takeFullStream> | undefined
  let usage: Awaited<LLM.StreamOutput["usage"]> | undefined
  let result:
    | { type: "complete"; requestId: string; turns: number; usage?: unknown }
    | { type: "error"; requestId: string; error: AgentTurnProtocol.SerializedError }

  try {
    await ScopeContext.provide({
      scope: envelope.scope,
      workspace: envelope.workspace,
      fn: async () => {
        const tools = ToolCatalog.modelTools(input.toolDefinitions) as Record<string, AITool>
        const stream = await LLM.stream({
          ...input,
          abort: turn.controller.signal,
          tools,
          messages: input.messages as ModelMessage[],
        })
        send({
          type: "started",
          requestId: turn.requestId,
        })
        ownedStream = LLM.takeFullStream(stream)
        await streamEvents(turn, ownedStream.stream)
        usage = await stream.usage.catch(() => undefined)
      },
    })
    turns++
    result = {
      type: "complete",
      requestId: turn.requestId,
      turns,
      usage,
    }
  } catch (error) {
    result = {
      type: "error",
      requestId: turn.requestId,
      error: AgentTurnProtocol.serializeError(error),
    }
  }
  // Release the per-session replay plan now that the turn has terminated
  // (completion, failure, or cancellation all converge here). Keeping it
  // registered across turns would let a long-lived worker retain ~20K tokens
  // of history plus the opaque artifact per handled session indefinitely.
  const sessionID = (input as { sessionID?: unknown }).sessionID
  if (typeof sessionID === "string" && sessionID) clearReplayPlan(sessionID)
  const memoryBeforeDispose = memory()
  await ownedStream?.dispose().catch(() => {})
  turn.windowWaiter?.()
  turn.windowWaiter = undefined
  return {
    ...result!,
    memoryBeforeDispose,
    memory: memory(),
  }
}

async function run(requestId: string, envelope: AgentTurnProtocol.TurnEnvelope | undefined): Promise<void> {
  if (active) {
    reject(requestId, new Error("Agent worker already owns a turn"))
    return
  }
  const turn: ActiveTurn = {
    requestId,
    controller: new AbortController(),
    windowWaiter: undefined,
    unackedBytes: 0,
    unackedFrames: [],
  }
  active = turn
  const terminal = await executeTurn(turn, envelope!)
  envelope = undefined
  active = undefined
  send(terminal)

  release(requestId)
  if (shuttingDown) process.exit(0)
}

process.on("message", (raw: unknown) => {
  const parsed = AgentTurnProtocol.HostToWorkerSchema.safeParse(raw)
  if (!parsed.success) {
    const requestId =
      raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string"
        ? raw.requestId
        : "invalid"
    reject(requestId, new Error("Invalid Agent worker protocol message"))
    return
  }
  const message = parsed.data
  if (message.type === "run-start") {
    if (active || pending) {
      reject(message.requestId, new Error("Agent worker already owns a turn transfer"))
      return
    }
    pending = {
      requestId: message.requestId,
      totalBytes: message.totalBytes,
      chunkCount: message.chunkCount,
      chunks: [],
      receivedBytes: 0,
    }
    send({ type: "run-ready", requestId: message.requestId })
    return
  }
  if (message.type === "run-chunk") {
    if (!pending || pending.requestId !== message.requestId || message.index !== pending.chunks.length) {
      pending = undefined
      rejectAndRelease(message.requestId, new Error("Invalid Agent turn request chunk sequence"))
      return
    }
    pending.chunks.push(message.data)
    pending.receivedBytes += message.data.byteLength
    if (pending.receivedBytes > pending.totalBytes || pending.chunks.length > pending.chunkCount) {
      pending = undefined
      rejectAndRelease(message.requestId, new Error("Agent turn request transfer exceeded declared bounds"))
      return
    }
    send({ type: "chunk-ack", requestId: message.requestId, index: message.index })
    return
  }
  if (message.type === "run-commit") {
    const transfer = pending
    pending = undefined
    if (
      !transfer ||
      transfer.requestId !== message.requestId ||
      transfer.receivedBytes !== transfer.totalBytes ||
      transfer.chunks.length !== transfer.chunkCount
    ) {
      rejectAndRelease(message.requestId, new Error("Incomplete Agent turn request transfer"))
      return
    }
    try {
      const bytes = Buffer.concat(transfer.chunks, transfer.totalBytes)
      const envelope = AgentTurnProtocol.deserializeTurn(bytes)
      void run(message.requestId, envelope)
    } catch (error) {
      rejectAndRelease(message.requestId, error)
    }
    return
  }
  if (message.type === "ack-window") {
    if (!active || active.requestId !== message.requestId) return
    // Credit only frames covered by the acknowledged sequence; frames sent
    // after it remain unacknowledged and keep counting toward the window.
    active.unackedFrames = active.unackedFrames.filter((frame) => frame.sequence > message.ackSequence)
    active.unackedBytes = active.unackedFrames.reduce((total, frame) => total + frame.bytes, 0)
    // A partial acknowledgement that does not bring the worker back under the
    // window must not release the pause: the waiter stays armed until the
    // host acknowledges enough bytes for the stream to safely continue.
    if (active.unackedBytes < AgentTurnProtocol.ACK_WINDOW_BYTES) {
      const waiter = active.windowWaiter
      active.windowWaiter = undefined
      waiter?.()
    }
    return
  }
  if (message.type === "cancel") {
    if (pending?.requestId === message.requestId) {
      pending = undefined
      rejectAndRelease(message.requestId, new DOMException(message.reason ?? "Agent turn aborted", "AbortError"))
      return
    }
    if (active?.requestId === message.requestId) {
      active.controller.abort(new DOMException(message.reason ?? "Agent turn aborted", "AbortError"))
    }
    return
  }
  if (message.type === "collect-memory") {
    if (active?.requestId !== message.requestId && pending?.requestId !== message.requestId) return
    Bun.gc(true)
    send({
      type: "heartbeat",
      requestId: message.requestId,
      turns,
      collection: "full",
      memory: memory(),
    })
    return
  }
  if (message.type === "shutdown") {
    shuttingDown = true
    if (idleSampleTimer) clearTimeout(idleSampleTimer)
    pending = undefined
    if (active) active.controller.abort(new DOMException("Agent worker shutting down", "AbortError"))
    else process.exit(0)
    return
  }
  if (message.type === "ping") send({ type: "pong" })
})

const heartbeat = setInterval(() => {
  send({
    type: "heartbeat",
    requestId: active?.requestId,
    turns,
    collection: "none",
    memory: memory(),
  })
}, 15_000)
heartbeat.unref()

watchManagedParent({
  expectedParentPid: process.env.SYNERGY_AGENT_PARENT_PID,
  onParentExit: () => process.exit(0),
})

send({ type: "ready", protocolVersion: AgentTurnProtocol.VERSION, pid: process.pid, memory: memory() })
