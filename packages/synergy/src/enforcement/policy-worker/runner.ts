import { watchManagedParent } from "@/server/managed-parent"
import { EnforcementGate, type GateOptions } from "../gate"
import { PolicyWorkerProtocol, type PolicyClassificationInput } from "./protocol"

let activeRequestId: string | undefined
let pending:
  | {
      requestId: string
      totalBytes: number
      chunkCount: number
      chunks: Uint8Array[]
      receivedBytes: number
    }
  | undefined
let requests = 0
let shuttingDown = false

function send(message: PolicyWorkerProtocol.WorkerToHost): void {
  PolicyWorkerProtocol.assertIpcFrameBound(message)
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

async function classify(input: PolicyClassificationInput) {
  const context = input.context
  const gate = await EnforcementGate.create({
    activeWorkspace: context.activeWorkspace,
    workspaceType: context.workspaceType,
    profileId: "guarded",
    registeredMcpTools: new Set(context.registeredMcpTools),
    registeredPluginTools: new Set(context.registeredPluginTools),
    pluginToolCapabilities: context.pluginToolCapabilities,
    pluginApprovals: context.pluginApprovals as unknown as GateOptions["pluginApprovals"],
    originalCheckout: context.originalCheckout,
    readRoots: context.readRoots,
    trustedRoots: context.trustedRoots,
    synergyRoot: context.synergyRoot,
  })
  return gate.classify(input.toolName, input.args)
}

async function run(requestId: string, input: PolicyClassificationInput): Promise<void> {
  if (activeRequestId) {
    send({
      type: "error",
      requestId,
      error: PolicyWorkerProtocol.serializeError(new Error("Policy worker already owns a request")),
    })
    return
  }

  activeRequestId = requestId
  try {
    let ownedInput: PolicyClassificationInput | undefined = input
    const result = await classify(ownedInput)
    requests++
    const memoryBeforeRelease = memory()
    ownedInput = undefined
    send({
      type: "result",
      requestId,
      result,
      requests,
      memoryBeforeRelease,
      memoryAfterRelease: memory(),
    })
  } catch (error) {
    send({
      type: "error",
      requestId,
      error: PolicyWorkerProtocol.serializeError(error),
    })
  } finally {
    activeRequestId = undefined
    setTimeout(() => {
      send({ type: "released", requestId, requests, memory: memory() })
    }, 0)
    if (shuttingDown) process.exit(0)
  }
}

process.on("message", (raw: unknown) => {
  const parsed = PolicyWorkerProtocol.HostToWorkerSchema.safeParse(raw)
  if (!parsed.success) {
    const requestId =
      raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string"
        ? raw.requestId
        : "invalid"
    send({
      type: "error",
      requestId,
      error: PolicyWorkerProtocol.serializeError(new Error("Invalid Policy worker protocol message")),
    })
    return
  }

  const message = parsed.data
  if (message.type === "run-start") {
    if (activeRequestId || pending) {
      send({
        type: "error",
        requestId: message.requestId,
        error: PolicyWorkerProtocol.serializeError(new Error("Policy worker already owns a request transfer")),
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
        error: PolicyWorkerProtocol.serializeError(new Error("Invalid Policy request chunk sequence")),
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
        error: PolicyWorkerProtocol.serializeError(new Error("Policy request transfer exceeded declared bounds")),
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
        error: PolicyWorkerProtocol.serializeError(new Error("Incomplete Policy request transfer")),
      })
      return
    }
    try {
      const bytes = Buffer.concat(transfer.chunks, transfer.totalBytes)
      const input = PolicyWorkerProtocol.deserializeInput(bytes)
      void run(message.requestId, input)
    } catch (error) {
      send({
        type: "error",
        requestId: message.requestId,
        error: PolicyWorkerProtocol.serializeError(error),
      })
    }
    return
  }

  if (message.type === "cancel") {
    if (pending?.requestId === message.requestId) {
      pending = undefined
      send({
        type: "error",
        requestId: message.requestId,
        error: PolicyWorkerProtocol.serializeError(new DOMException("Policy classification aborted", "AbortError")),
      })
    }
    return
  }

  if (message.type === "shutdown") {
    shuttingDown = true
    pending = undefined
    if (!activeRequestId) process.exit(0)
    return
  }

  if (message.type === "ping") send({ type: "pong" })
})

const heartbeat = setInterval(() => {
  send({
    type: "heartbeat",
    requestId: activeRequestId,
    requests,
    memory: memory(),
  })
}, 5_000)
heartbeat.unref()

watchManagedParent({
  expectedParentPid: process.env.SYNERGY_POLICY_PARENT_PID,
  onParentExit: () => process.exit(0),
})

send({ type: "ready", protocolVersion: PolicyWorkerProtocol.VERSION, pid: process.pid, memory: memory() })
