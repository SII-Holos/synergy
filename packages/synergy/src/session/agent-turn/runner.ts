import type { ModelMessage, Tool as AITool } from "ai"
import { ScopeContext } from "@/scope/context"
import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import { watchManagedParent } from "@/server/managed-parent"
import { AgentTurnProtocol } from "./protocol"
import type { AgentTurnWorkerInput } from "./worker-pool"

type AgentSDKStreamPart = LLM.StreamOutput["fullStream"] extends AsyncIterable<infer Part> ? Part : never

interface ActiveTurn {
  requestId: string
  controller: AbortController
  acknowledgements: Map<number, () => void>
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

async function sendEvents(turn: ActiveTurn, events: AgentSDKStreamPart[]): Promise<void> {
  if (events.length === 0) return
  const frame = {
    type: "events" as const,
    requestId: turn.requestId,
    sequence: ++sequence,
    events: AgentTurnProtocol.encodeEvents(events),
  }
  AgentTurnProtocol.assertEventFrameBound(frame)
  await new Promise<void>((resolve, reject) => {
    if (turn.controller.signal.aborted) {
      reject(turn.controller.signal.reason)
      return
    }
    const onAbort = () => {
      turn.acknowledgements.delete(frame.sequence)
      reject(turn.controller.signal.reason)
    }
    turn.controller.signal.addEventListener("abort", onAbort, { once: true })
    turn.acknowledgements.set(frame.sequence, () => {
      turn.controller.signal.removeEventListener("abort", onAbort)
      resolve()
    })
    send(frame)
  })
}

function isTextDelta(value: AgentSDKStreamPart): value is AgentSDKStreamPart & {
  type: "text-delta" | "reasoning-delta"
  id: string
  text: string
} {
  if (!value || typeof value !== "object" || !("type" in value)) return false
  return value.type === "text-delta" || value.type === "reasoning-delta"
}

async function streamEvents(turn: ActiveTurn, stream: AsyncIterable<AgentSDKStreamPart>): Promise<void> {
  let pending: AgentSDKStreamPart | undefined
  let pendingAt = 0

  const flush = async () => {
    if (!pending) return
    const value = pending
    pending = undefined
    await sendEvents(turn, [value])
  }

  for await (const value of stream) {
    turn.controller.signal.throwIfAborted()
    if (!isTextDelta(value)) {
      await flush()
      await sendEvents(turn, [value])
      continue
    }
    if (
      pending &&
      isTextDelta(pending) &&
      pending.type === value.type &&
      pending.id === value.id &&
      Date.now() - pendingAt < 16 &&
      pending.text.length + value.text.length <= 32 * 1024
    ) {
      pending = { ...pending, text: pending.text + value.text }
      continue
    }
    await flush()
    pending = value
    pendingAt = Date.now()
  }
  await flush()
}

async function run(requestId: string, envelope: AgentTurnProtocol.TurnEnvelope): Promise<void> {
  if (active) {
    send({
      type: "error",
      requestId,
      error: AgentTurnProtocol.serializeError(new Error("Agent worker already owns a turn")),
    })
    return
  }
  const turn: ActiveTurn = {
    requestId,
    controller: new AbortController(),
    acknowledgements: new Map(),
  }
  active = turn
  const input = envelope.input as unknown as AgentTurnWorkerInput
  let ownedStream: ReturnType<typeof LLM.takeFullStream> | undefined
  let usage: Awaited<LLM.StreamOutput["usage"]> | undefined
  let terminal:
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
          contextUsageDraft: stream.contextUsageDraft,
        })
        ownedStream = LLM.takeFullStream(stream)
        await streamEvents(turn, ownedStream.stream)
        usage = await stream.usage.catch(() => undefined)
      },
    })
    turns++
    terminal = {
      type: "complete",
      requestId: turn.requestId,
      turns,
      usage,
    }
  } catch (error) {
    terminal = {
      type: "error",
      requestId: turn.requestId,
      error: AgentTurnProtocol.serializeError(error),
    }
  } finally {
    const memoryBeforeDispose = memory()
    await ownedStream?.dispose().catch(() => {})
    for (const acknowledge of turn.acknowledgements.values()) acknowledge()
    active = undefined
    send({
      ...terminal!,
      memoryBeforeDispose,
      memory: memory(),
    })
    if (shuttingDown) process.exit(0)
  }
}

process.on("message", (raw: unknown) => {
  const parsed = AgentTurnProtocol.HostToWorkerSchema.safeParse(raw)
  if (!parsed.success) {
    const requestId =
      raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string"
        ? raw.requestId
        : "invalid"
    send({
      type: "error",
      requestId,
      error: AgentTurnProtocol.serializeError(new Error("Invalid Agent worker protocol message")),
    })
    return
  }
  const message = parsed.data
  if (message.type === "run-start") {
    if (active || pending) {
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(new Error("Agent worker already owns a turn transfer")),
      })
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
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(new Error("Invalid Agent turn request chunk sequence")),
      })
      return
    }
    pending.chunks.push(message.data)
    pending.receivedBytes += message.data.byteLength
    if (pending.receivedBytes > pending.totalBytes || pending.chunks.length > pending.chunkCount) {
      pending = undefined
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(new Error("Agent turn request transfer exceeded declared bounds")),
      })
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
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(new Error("Incomplete Agent turn request transfer")),
      })
      return
    }
    try {
      const bytes = Buffer.concat(transfer.chunks, transfer.totalBytes)
      const envelope = AgentTurnProtocol.deserializeTurn(bytes)
      void run(message.requestId, envelope)
    } catch (error) {
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(error),
      })
    }
    return
  }
  if (message.type === "ack") {
    if (!active || active.requestId !== message.requestId) return
    const acknowledge = active.acknowledgements.get(message.sequence)
    if (!acknowledge) return
    active.acknowledgements.delete(message.sequence)
    acknowledge()
    return
  }
  if (message.type === "cancel") {
    if (pending?.requestId === message.requestId) {
      pending = undefined
      send({
        type: "error",
        requestId: message.requestId,
        error: AgentTurnProtocol.serializeError(new DOMException(message.reason ?? "Agent turn aborted", "AbortError")),
      })
      return
    }
    if (active?.requestId === message.requestId) {
      active.controller.abort(new DOMException(message.reason ?? "Agent turn aborted", "AbortError"))
    }
    return
  }
  if (message.type === "shutdown") {
    shuttingDown = true
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
    memory: memory(),
  })
}, 15_000)
heartbeat.unref()

watchManagedParent({
  expectedParentPid: process.env.SYNERGY_AGENT_PARENT_PID,
  onParentExit: () => process.exit(0),
})

send({ type: "ready", protocolVersion: AgentTurnProtocol.VERSION, pid: process.pid, memory: memory() })
