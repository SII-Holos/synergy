import { availableParallelism } from "os"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { ObservabilityMetrics } from "@/observability/metrics"
import type { LLM } from "../llm"
import type { ToolCatalog } from "../tool-catalog"
import { AgentTurnProtocol } from "./protocol"
import { spawnAgentWorkerProcess, type AgentWorkerProcess, type SpawnAgentWorkerProcessOptions } from "./process-host"

export type AgentTurnStreamPart = AgentTurnProtocol.StreamEvent

export interface AgentTurnInput extends Omit<LLM.StreamInput, "tools" | "memoryTurn" | "prepared"> {
  toolDefinitions: ToolCatalog.Definition[]
}

export type AgentTurnWorkerInput = Omit<AgentTurnInput, "abort" | "user" | "agent"> & {
  user: Pick<AgentTurnInput["user"], "id">
  agent: Pick<AgentTurnInput["agent"], "name">
  prepared: LLM.PreparedTurn
}

type AgentTurnPoolInput = AgentTurnInput & {
  prepared: LLM.PreparedTurn
}

export interface AgentTurnStream {
  fullStream: AsyncIterable<AgentTurnStreamPart>
  contextUsageDraft?: LLM.StreamOutput["contextUsageDraft"]
  usage: Promise<Awaited<LLM.StreamOutput["usage"]> | undefined>
  dispose(): Promise<void>
}

export interface AgentWorkerPoolOptions {
  size: number
  minIdle: number
  idleTimeoutMs: number
  maxQueued: number
  maxQueuedBytes: number
  maxTurns: number
  maxRssBytes: number
  maxHeapBytes: number
  idleBaselineRecycle: boolean
  idleBaselineRssGrowthBytes: number
  idleBaselineExternalGrowthBytes: number
  cancelGraceMs: number
  heartbeatTimeoutMs: number
}

export interface AgentWorkerSupervisorOptions {
  startupBackoffBaseMs: number
  startupBackoffMaxMs: number
  maxConsecutiveStartupFailures: number
  sleep(ms: number): Promise<void>
}

const DEFAULT_AGENT_WORKER_SUPERVISOR_OPTIONS: AgentWorkerSupervisorOptions = {
  startupBackoffBaseMs: 250,
  startupBackoffMaxMs: 4_000,
  maxConsecutiveStartupFailures: 5,
  sleep: Bun.sleep,
}

interface PoolTask {
  requestId: string
  queuedAt: number
  startedAt?: number
  requestBytes: number
  payload: Uint8Array
  nextChunk: number
  sessionID: string
  messageID: string
  signal: AbortSignal
  stream: FrameStream
  usage: Promise<Awaited<LLM.StreamOutput["usage"]> | undefined>
  resolve(stream: AgentTurnStream): void
  reject(error: unknown): void
  resolveUsage(usage: Awaited<LLM.StreamOutput["usage"]> | undefined): void
  started: boolean
  terminal: boolean
  terminalReason?: "complete" | "error"
  completed: boolean
  transferCommitted: boolean
  worker?: PoolWorker
  removeAbortListener(): void
}

interface PoolWorker {
  id: string
  host: AgentWorkerProcess
  ready: boolean
  startupFailureEligible: boolean
  stopping: boolean
  retireAfterTask: boolean
  task?: PoolTask
  turns: number
  pid?: number
  rssBytes?: number
  heapUsedBytes?: number
  heapTotalBytes?: number
  externalBytes?: number
  arrayBuffersBytes?: number
  peakRssBytes?: number
  idleBaselineRssBytes?: number
  idleBaselineExternalBytes?: number
  idleSince?: number
  activeHeapPressureRequestId?: string
  lastEventSequence: number
  lastHeartbeatAt: number
}

interface Frame {
  sequence: number
  events: AgentTurnStreamPart[]
  acknowledge(): void
}

class FrameStream {
  private frame: Frame | undefined
  private waiter: (() => void) | undefined
  private done = false
  private failure: unknown

  push(frame: Frame): boolean {
    if (this.done) return false
    if (this.frame) {
      this.fail(new Error("Agent worker sent a second event frame before the first was acknowledged"))
      return false
    }
    this.frame = frame
    this.wake()
    return true
  }

  complete(): void {
    this.done = true
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.done = true
    this.wake()
  }

  async *iterate(): AsyncGenerator<AgentTurnStreamPart> {
    while (true) {
      if (this.failure) throw this.failure
      const frame = this.frame
      if (frame) {
        try {
          for (const event of frame.events) yield event
        } finally {
          this.frame = undefined
          frame.acknowledge()
        }
        continue
      }
      if (this.done) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

export class AgentWorkerPool {
  private readonly log = Log.create({ service: "agent.worker.pool" })
  private readonly workers = new Map<string, PoolWorker>()
  private readonly queue: PoolTask[] = []
  private queuedBytes = 0
  private stopping = false
  private readonly healthTimer: ReturnType<typeof setInterval>
  private readonly supervisor: AgentWorkerSupervisorOptions
  private consecutiveStartupFailures = 0
  private startupRetryGeneration = 0
  private startupCircuitError: Error | undefined
  private startupRetryPending = false
  private targetSize: number
  private rebalancing = false
  private rebalancePending = false
  private lastRecovery:
    | {
        action: "recycle"
        reason: string
        at: number
        beforeBytes?: number
        afterBytes?: number
        reclaimedBytes?: number
      }
    | undefined

  constructor(
    private readonly options: AgentWorkerPoolOptions,
    private readonly spawn: (options: SpawnAgentWorkerProcessOptions) => AgentWorkerProcess = spawnAgentWorkerProcess,
    supervisor: Partial<AgentWorkerSupervisorOptions> = {},
  ) {
    this.supervisor = { ...DEFAULT_AGENT_WORKER_SUPERVISOR_OPTIONS, ...supervisor }
    if (!Number.isInteger(options.size) || options.size <= 0) {
      throw new Error("Agent worker pool size must be a positive integer")
    }
    if (!Number.isInteger(options.minIdle) || options.minIdle < 0 || options.minIdle > options.size) {
      throw new Error("Agent worker pool minIdle must be a non-negative integer no greater than size")
    }
    if (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
      throw new Error("Agent worker pool idleTimeoutMs must be a positive integer")
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error("Agent worker pool maxQueued must be a non-negative integer")
    }
    this.targetSize = options.size
    this.healthTimer = setInterval(
      () => this.sweepHealth(),
      Math.max(10, Math.min(5_000, options.heartbeatTimeoutMs, options.idleTimeoutMs)),
    )
    this.healthTimer.unref()
    this.ensureWorkers()
  }

  run(input: AgentTurnPoolInput): Promise<AgentTurnStream> {
    const signal = input.abort
    if (this.stopping) return Promise.reject(new Error("Agent worker pool is stopping"))
    if (this.startupCircuitError) return Promise.reject(this.startupCircuitError)
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Agent turn aborted", "AbortError"))
    const activeTasks = this.activeTaskCount()
    if (activeTasks + this.queue.length >= this.targetSize + this.options.maxQueued) {
      return Promise.reject(new Error(`Agent worker queue is full (${this.options.maxQueued} waiting)`))
    }

    const requestId = `agent_turn_${crypto.randomUUID()}`
    const { abort: _abort, ...turnInput } = input
    const workerInput: AgentTurnWorkerInput = {
      ...turnInput,
      user: { id: input.user.id },
      agent: { name: input.agent.name },
      system: [],
    }
    const envelope = {
      scope: ScopeContext.current.scope,
      workspace: ScopeContext.current.workspace,
      input: workerInput,
    }
    const payload = AgentTurnProtocol.serializeTurn(envelope as unknown as AgentTurnProtocol.TurnEnvelope)
    const requestBytes = payload.byteLength
    if (this.queuedBytes + requestBytes > this.options.maxQueuedBytes) {
      return Promise.reject(
        new Error(`Agent worker queue exceeded ${this.options.maxQueuedBytes} bytes of waiting turns`),
      )
    }

    return new Promise<AgentTurnStream>((resolve, reject) => {
      const stream = new FrameStream()
      let resolveUsage!: (usage: Awaited<LLM.StreamOutput["usage"]> | undefined) => void
      const usage = new Promise<Awaited<LLM.StreamOutput["usage"]> | undefined>((resolve) => {
        resolveUsage = resolve
      })
      const onAbort = () => this.cancel(requestId, signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      const task: PoolTask = {
        requestId,
        queuedAt: Date.now(),
        requestBytes,
        payload,
        nextChunk: 0,
        sessionID: input.sessionID,
        messageID: input.user.id,
        signal,
        stream,
        usage,
        resolve,
        reject,
        resolveUsage,
        started: false,
        terminal: false,
        completed: false,
        transferCommitted: false,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      }
      this.queue.push(task)
      this.queuedBytes += requestBytes
      ObservabilityMetrics.record({
        name: "agent.queue.depth",
        value: this.queue.length,
        unit: "count",
        module: "session",
        sessionID: input.sessionID,
      })
      ObservabilityMetrics.record({
        name: "agent.ipc.request_bytes",
        value: requestBytes,
        unit: "bytes",
        module: "session",
        sessionID: input.sessionID,
        messageID: input.user.id,
      })
      this.ensureWorkers()
      this.drain()
    })
  }

  resize(size: number): void {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Agent worker pool size must be a positive integer")
    }
    this.targetSize = size
    this.rebalanceCapacity()
  }

  stats() {
    let active = 0
    let ready = 0
    for (const worker of this.workers.values()) {
      if (worker.ready) ready++
      if (worker.task) active++
    }
    return {
      configured: this.targetSize,
      minIdle: this.options.minIdle,
      idleTimeoutMs: this.options.idleTimeoutMs,
      maxQueued: this.options.maxQueued,
      maxQueuedBytes: this.options.maxQueuedBytes,
      workers: this.workers.size,
      ready,
      active,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      rssBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.rssBytes ?? 0), 0),
      heapUsedBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.heapUsedBytes ?? 0), 0),
      heapTotalBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.heapTotalBytes ?? 0), 0),
      externalBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.externalBytes ?? 0), 0),
      arrayBuffersBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.arrayBuffersBytes ?? 0), 0),
      baselineBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.idleBaselineRssBytes ?? 0), 0),
      peakBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.peakRssBytes ?? 0), 0),
      retainedBytes: [...this.workers.values()].reduce(
        (sum, worker) =>
          sum + Math.max(0, (worker.rssBytes ?? 0) - (worker.idleBaselineRssBytes ?? worker.rssBytes ?? 0)),
        0,
      ),
      measuredWorkers: [...this.workers.values()].filter((worker) => worker.rssBytes !== undefined).length,
      lastRecovery: this.lastRecovery,
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.healthTimer)
    this.startupRetryGeneration++
    const error = new Error("Agent worker pool stopped")
    for (const task of this.queue.splice(0)) {
      this.queuedBytes -= task.requestBytes
      task.removeAbortListener()
      task.reject(error)
    }
    for (const worker of this.workers.values()) {
      if (worker.task) {
        worker.task.stream.fail(error)
        worker.task.resolveUsage(undefined)
        worker.task.removeAbortListener()
      }
      worker.stopping = true
    }
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.host.stop(this.options.cancelGraceMs)))
    this.workers.clear()
  }

  private ensureWorkers(): void {
    if (this.startupRetryPending) return
    while (!this.stopping && !this.startupCircuitError && this.liveWorkerCount() < this.desiredWorkerCount()) {
      if (!this.spawnWorker()) return
    }
  }

  private rebalanceCapacity(): void {
    if (this.stopping) return
    if (this.rebalancing) {
      this.rebalancePending = true
      return
    }
    this.rebalancing = true
    try {
      do {
        this.rebalancePending = false
        for (const worker of this.workers.values()) worker.retireAfterTask = false

        let excess = Math.max(0, this.liveWorkerCount() - this.targetSize)
        for (const worker of [...this.workers.values()]) {
          if (excess === 0) break
          if (worker.stopping || worker.task) continue
          this.recycle(worker, "pool_resize")
          excess--
        }

        excess = Math.max(0, this.liveWorkerCount() - this.targetSize)
        for (const worker of this.workers.values()) {
          if (excess === 0) break
          if (worker.stopping || !worker.task) continue
          worker.retireAfterTask = true
          excess--
        }

        this.ensureWorkers()
        this.drain()
      } while (this.rebalancePending)
    } finally {
      this.rebalancing = false
    }
  }

  private activeTaskCount(): number {
    return [...this.workers.values()].filter((worker) => !worker.stopping && worker.task).length
  }

  private liveWorkerCount(): number {
    return [...this.workers.values()].filter((worker) => !worker.stopping).length
  }

  private desiredWorkerCount(): number {
    const demand = this.activeTaskCount() + this.queue.length
    return Math.min(this.targetSize, Math.max(this.options.minIdle, demand + this.options.minIdle))
  }

  private spawnWorker(): boolean {
    const id = `agent_worker_${crypto.randomUUID()}`
    let worker!: PoolWorker
    try {
      const host = this.spawn({
        onMessage: (message) => this.onMessage(worker, message),
        onExit: (exitCode, signal) => this.onExit(worker, exitCode, signal),
      })
      worker = {
        id,
        host,
        ready: false,
        startupFailureEligible: true,
        stopping: false,
        retireAfterTask: false,
        turns: 0,
        lastEventSequence: 0,
        lastHeartbeatAt: Date.now(),
      }
      this.workers.set(id, worker)
      return true
    } catch (error) {
      this.handleStartupFailure(error)
      return false
    }
  }

  private onMessage(worker: PoolWorker, message: AgentTurnProtocol.WorkerToHost): void {
    if (message.type === "ready") {
      if (worker.ready || worker.task || message.protocolVersion !== AgentTurnProtocol.VERSION) {
        this.terminateForProtocol(worker, "unexpected or incompatible ready message")
        return
      }
      worker.ready = true
      worker.startupFailureEligible = false
      worker.pid = message.pid
      worker.lastHeartbeatAt = Date.now()
      worker.idleSince = Date.now()
      this.recordWorkerMemory(worker, message.memory, "ready")
      this.consecutiveStartupFailures = 0
      this.startupCircuitError = undefined
      this.ensureWorkers()
      this.drain()
      return
    }
    if (message.type === "heartbeat") {
      if (message.requestId !== undefined && message.requestId !== worker.task?.requestId) {
        this.terminateForProtocol(worker, "heartbeat referenced an unowned turn")
        return
      }
      this.recordWorkerMemory(
        worker,
        message.memory,
        message.collection === "full" ? "heartbeat.post_collection" : "heartbeat",
      )
      worker.lastHeartbeatAt = Date.now()
      if (message.memory.rssBytes >= this.options.maxRssBytes) {
        this.terminateForMemory(worker, message.memory)
        return
      }
      if (!worker.task) {
        const baselineReason = this.baselineRecycleReason(worker, message.memory)
        if (baselineReason) this.recycle(worker, baselineReason)
        return
      }
      if (message.memory.heapUsedBytes < this.options.maxHeapBytes) {
        worker.activeHeapPressureRequestId = undefined
        return
      }
      const task = worker.task
      if (!task) {
        this.terminateForMemory(worker, message.memory)
        return
      }
      if (message.collection === "full" && worker.activeHeapPressureRequestId === task.requestId) {
        this.terminateForMemory(worker, message.memory)
        return
      }
      if (worker.activeHeapPressureRequestId !== task.requestId) {
        worker.activeHeapPressureRequestId = task.requestId
        this.send(worker, { type: "collect-memory", requestId: task.requestId })
      }
      return
    }
    if (message.type === "pong") return

    const task = worker.task
    if (!task || "requestId" in message === false || message.requestId !== task.requestId) {
      this.terminateForProtocol(worker, "message referenced an unowned turn")
      return
    }
    if (message.type === "run-ready") {
      if (task.nextChunk !== 0 || task.transferCommitted) {
        this.terminateForProtocol(worker, "unexpected run-ready")
        return
      }
      this.sendNextChunk(worker, task)
      return
    }
    if (message.type === "chunk-ack") {
      if (task.transferCommitted || message.index !== task.nextChunk - 1) {
        this.terminateForProtocol(worker, "invalid chunk acknowledgement")
        return
      }
      this.sendNextChunk(worker, task)
      return
    }
    if (message.type === "started") {
      if (!task.transferCommitted || task.started) {
        this.terminateForProtocol(worker, "unexpected turn start")
        return
      }
      task.started = true
      task.startedAt = Date.now()
      ObservabilityMetrics.record({
        name: "agent.queue.wait",
        value: Date.now() - task.queuedAt,
        unit: "ms",
        module: "session",
        sessionID: task.sessionID,
        messageID: task.messageID,
        processId: worker.id,
        pid: worker.pid,
      })
      task.resolve({
        fullStream: task.stream.iterate(),
        contextUsageDraft: message.contextUsageDraft as LLM.StreamOutput["contextUsageDraft"],
        usage: task.usage,
        dispose: () => this.disposeTask(task),
      })
      return
    }
    if (message.type === "events") {
      if (!task.started || message.sequence !== worker.lastEventSequence + 1) {
        this.terminateForProtocol(worker, "invalid event sequence")
        return
      }
      AgentTurnProtocol.assertEventFrameBound(message)
      worker.lastEventSequence = message.sequence
      ObservabilityMetrics.record({
        name: "agent.ipc.event_bytes",
        value: AgentTurnProtocol.byteLength(message),
        unit: "bytes",
        module: "session",
        sessionID: task.sessionID,
        messageID: task.messageID,
        processId: worker.id,
        pid: worker.pid,
      })
      const accepted = task.stream.push({
        sequence: message.sequence,
        events: AgentTurnProtocol.decodeEvents(message.events) as AgentTurnStreamPart[],
        acknowledge: () => {
          if (worker.task !== task || task.completed) return
          this.send(worker, { type: "ack", requestId: task.requestId, sequence: message.sequence })
        },
      })
      if (!accepted) this.terminateForProtocol(worker, "event frame sent before acknowledgement")
      return
    }
    if (message.type === "error") {
      if (task.terminal) {
        this.terminateForProtocol(worker, "duplicate turn terminal")
        return
      }
      task.terminal = true
      task.terminalReason = "error"
      const error = AgentTurnProtocol.deserializeError(message.error)
      if (message.memoryBeforeDispose) {
        this.recordWorkerMemory(worker, message.memoryBeforeDispose, "turn.before_dispose", task)
      }
      if (message.memory) this.recordWorkerMemory(worker, message.memory, "turn.after_dispose", task)
      task.resolveUsage(undefined)
      if (task.started) task.stream.fail(error)
      else task.reject(error)
      task.removeAbortListener()
      return
    }
    if (message.type === "complete") {
      if (!task.started) {
        this.terminateForProtocol(worker, "turn completed before start")
        return
      }
      if (task.terminal) {
        this.terminateForProtocol(worker, "duplicate turn terminal")
        return
      }
      task.terminal = true
      task.terminalReason = "complete"
      worker.turns = message.turns
      this.recordWorkerMemory(worker, message.memoryBeforeDispose, "turn.before_dispose", task)
      this.recordWorkerMemory(worker, message.memory, "turn.after_dispose", task)
      task.resolveUsage(message.usage as Awaited<LLM.StreamOutput["usage"]> | undefined)
      task.stream.complete()
      task.removeAbortListener()
      return
    }
    if (message.type === "released") {
      if (!task.terminal) {
        this.terminateForProtocol(worker, "turn released before terminal result")
        return
      }
      worker.turns = message.turns
      this.recordWorkerMemory(worker, message.memory, "turn.released", task)
      const recycle =
        message.turns >= this.options.maxTurns ||
        message.memory.rssBytes >= this.options.maxRssBytes ||
        message.memory.heapUsedBytes >= this.options.maxHeapBytes ||
        worker.retireAfterTask
      this.finishTask(worker, task, task.terminalReason ?? "released", !recycle)
      if (!recycle) return
      const reason =
        message.turns >= this.options.maxTurns
          ? "max_turns"
          : message.memory.rssBytes >= this.options.maxRssBytes
            ? "rss"
            : message.memory.heapUsedBytes >= this.options.maxHeapBytes
              ? "heap"
              : "pool_resize"
      this.recycle(worker, reason)
      return
    }
  }

  private onExit(worker: PoolWorker, exitCode: number | null, signal: string | null): void {
    this.workers.delete(worker.id)
    const error = new Error(`Agent worker exited (${exitCode ?? signal ?? "unknown"})`)
    const startupFailure = worker.startupFailureEligible
    const task = worker.task
    if (task && !task.completed) {
      if (!task.terminal) {
        if (task.started) task.stream.fail(error)
        else task.reject(error)
        task.resolveUsage(undefined)
      }
      task.completed = true
      task.removeAbortListener()
    }
    if (!this.stopping && !worker.stopping) {
      this.log.warn("agent worker exited", { workerID: worker.id, exitCode, signal })
      ObservabilityMetrics.record({
        name: "agent.worker.crash",
        value: 1,
        unit: "count",
        module: "session",
        processId: worker.id,
        pid: worker.pid,
        labels: { exitCode, signal },
      })
    }
    if (this.stopping) return
    if (startupFailure) {
      this.handleStartupFailure(error)
      return
    }
    this.rebalanceCapacity()
  }

  private handleStartupFailure(cause: unknown): void {
    if (this.stopping || this.startupCircuitError) return
    const failures = ++this.consecutiveStartupFailures
    if (failures > this.supervisor.maxConsecutiveStartupFailures) {
      this.openStartupCircuit(cause)
      return
    }
    const delayMs = Math.min(
      this.supervisor.startupBackoffMaxMs,
      this.supervisor.startupBackoffBaseMs * 2 ** (failures - 1),
    )
    const generation = ++this.startupRetryGeneration
    this.startupRetryPending = true
    this.log.warn("agent worker failed to start; retrying", { failures, delayMs, cause })
    void this.supervisor
      .sleep(delayMs)
      .then(() => {
        if (generation !== this.startupRetryGeneration) return
        this.startupRetryPending = false
        if (this.stopping || this.startupCircuitError) return
        this.ensureWorkers()
        this.drain()
      })
      .catch((error) => {
        if (generation !== this.startupRetryGeneration) return
        this.startupRetryPending = false
        if (this.stopping) return
        this.openStartupCircuit(error)
      })
  }

  private openStartupCircuit(cause: unknown): void {
    const attempts = this.consecutiveStartupFailures
    const error = new Error(`Agent worker failed to start after ${attempts} consecutive attempts`, { cause })
    this.startupCircuitError = error
    this.startupRetryPending = false
    this.startupRetryGeneration++
    this.log.error("agent worker startup circuit opened", { attempts, cause })
    ObservabilityMetrics.record({
      name: "agent.worker.startup_circuit_open",
      value: 1,
      unit: "count",
      module: "session",
      labels: { attempts },
    })
    for (const task of this.queue.splice(0)) {
      this.queuedBytes -= task.requestBytes
      task.removeAbortListener()
      task.resolveUsage(undefined)
      task.reject(error)
    }
  }

  private finishTask(worker: PoolWorker, task: PoolTask, reason: string, drain = true): void {
    if (task.completed) return
    task.completed = true
    task.removeAbortListener()
    if (worker.task === task) {
      worker.task = undefined
      worker.idleSince = Date.now()
      worker.activeHeapPressureRequestId = undefined
    }
    if (task.startedAt !== undefined) {
      ObservabilityMetrics.record({
        name: "agent.turn.duration",
        value: Date.now() - task.startedAt,
        unit: "ms",
        module: "session",
        sessionID: task.sessionID,
        messageID: task.messageID,
        processId: worker.id,
        pid: worker.pid,
        labels: { reason },
      })
    }
    this.log.debug("agent turn released worker", { workerID: worker.id, requestID: task.requestId, reason })
    if (drain) this.drain()
  }

  private recordWorkerMemory(
    worker: PoolWorker,
    memory: AgentTurnProtocol.WorkerMemory,
    phase:
      | "ready"
      | "heartbeat"
      | "heartbeat.post_collection"
      | "turn.before_dispose"
      | "turn.after_dispose"
      | "turn.released",
    task?: PoolTask,
  ): void {
    worker.rssBytes = memory.rssBytes
    worker.heapUsedBytes = memory.heapUsedBytes
    worker.heapTotalBytes = memory.heapTotalBytes
    worker.externalBytes = memory.externalBytes
    worker.arrayBuffersBytes = memory.arrayBuffersBytes
    worker.peakRssBytes = Math.max(worker.peakRssBytes ?? 0, memory.rssBytes)
    for (const [name, value] of Object.entries({
      "agent.worker.rss": memory.rssBytes,
      "agent.worker.heap_used": memory.heapUsedBytes,
      "agent.worker.heap_total": memory.heapTotalBytes,
      "agent.worker.external": memory.externalBytes,
      "agent.worker.array_buffers": memory.arrayBuffersBytes,
    })) {
      ObservabilityMetrics.record({
        name,
        value,
        unit: "bytes",
        module: "session",
        sessionID: task?.sessionID,
        messageID: task?.messageID,
        processId: worker.id,
        pid: worker.pid,
        labels: { phase, turns: worker.turns },
      })
    }
  }

  private baselineRecycleReason(
    worker: PoolWorker,
    memory: AgentTurnProtocol.WorkerMemory,
  ): "idle_rss_growth" | "idle_external_growth" | undefined {
    if (!this.options.idleBaselineRecycle) return
    const baselineRss = worker.idleBaselineRssBytes
    const baselineExternal = worker.idleBaselineExternalBytes
    worker.idleBaselineRssBytes = baselineRss === undefined ? memory.rssBytes : Math.min(baselineRss, memory.rssBytes)
    worker.idleBaselineExternalBytes =
      baselineExternal === undefined ? memory.externalBytes : Math.min(baselineExternal, memory.externalBytes)
    if (baselineRss === undefined || baselineExternal === undefined) return
    if (memory.rssBytes > baselineRss + this.options.idleBaselineRssGrowthBytes) return "idle_rss_growth"
    if (memory.externalBytes > baselineExternal + this.options.idleBaselineExternalGrowthBytes) {
      return "idle_external_growth"
    }
  }

  private recycle(
    worker: PoolWorker,
    reason: "max_turns" | "rss" | "heap" | "idle_rss_growth" | "idle_external_growth" | "idle_timeout" | "pool_resize",
  ): void {
    if (worker.stopping || this.stopping) return
    worker.stopping = true
    worker.ready = false
    worker.startupFailureEligible = false
    this.workers.delete(worker.id)
    const recovery: NonNullable<AgentWorkerPool["lastRecovery"]> = {
      action: "recycle" as const,
      reason,
      at: Date.now(),
      beforeBytes: worker.rssBytes,
    }
    this.lastRecovery = recovery
    ObservabilityMetrics.record({
      name: "agent.worker.recycle",
      value: 1,
      unit: "count",
      module: "session",
      processId: worker.id,
      pid: worker.pid,
      labels: {
        reason,
        turns: worker.turns,
        rssBytes: worker.rssBytes,
        heapUsedBytes: worker.heapUsedBytes,
        externalBytes: worker.externalBytes,
        idleBaselineRssBytes: worker.idleBaselineRssBytes,
        idleBaselineExternalBytes: worker.idleBaselineExternalBytes,
      },
    })
    void worker.host.stop(this.options.cancelGraceMs).then(
      () => {
        recovery.afterBytes = 0
        recovery.reclaimedBytes = recovery.beforeBytes
      },
      () => undefined,
    )
    this.ensureWorkers()
    this.drain()
  }

  private drain(): void {
    if (this.stopping) return
    for (const worker of this.workers.values()) {
      if (!worker.ready || worker.stopping || worker.task) continue
      const task = this.queue.shift()
      if (!task) return
      this.queuedBytes -= task.requestBytes
      if (task.signal.aborted) {
        task.removeAbortListener()
        task.reject(task.signal.reason ?? new DOMException("Agent turn aborted", "AbortError"))
        continue
      }
      worker.task = task
      worker.idleSince = undefined
      worker.activeHeapPressureRequestId = undefined
      task.worker = worker
      this.send(worker, {
        type: "run-start",
        requestId: task.requestId,
        totalBytes: task.payload.byteLength,
        chunkCount: Math.ceil(task.payload.byteLength / AgentTurnProtocol.REQUEST_CHUNK_BYTES),
      })
    }
  }

  private sendNextChunk(worker: PoolWorker, task: PoolTask): void {
    if (worker.task !== task || task.completed) return
    const start = task.nextChunk * AgentTurnProtocol.REQUEST_CHUNK_BYTES
    if (start >= task.payload.byteLength) {
      task.transferCommitted = true
      this.send(worker, { type: "run-commit", requestId: task.requestId })
      task.payload = new Uint8Array()
      return
    }
    const end = Math.min(start + AgentTurnProtocol.REQUEST_CHUNK_BYTES, task.payload.byteLength)
    const index = task.nextChunk++
    this.send(worker, {
      type: "run-chunk",
      requestId: task.requestId,
      index,
      data: task.payload.subarray(start, end),
    })
  }

  private cancel(requestId: string, reason?: unknown): void {
    const queuedIndex = this.queue.findIndex((task) => task.requestId === requestId)
    if (queuedIndex !== -1) {
      const [task] = this.queue.splice(queuedIndex, 1)
      this.queuedBytes -= task.requestBytes
      task.removeAbortListener()
      task.reject(reason ?? new DOMException("Agent turn aborted", "AbortError"))
      return
    }
    for (const worker of this.workers.values()) {
      if (worker.task?.requestId !== requestId) continue
      this.send(worker, {
        type: "cancel",
        requestId,
        reason:
          reason === undefined
            ? undefined
            : (reason instanceof Error ? reason.message : String(reason)).slice(
                0,
                AgentTurnProtocol.ERROR_MESSAGE_MAX_CHARS,
              ),
      })
      const ownedTask = worker.task
      setTimeout(() => {
        if (worker.task !== ownedTask || ownedTask.completed) return
        worker.host.process.kill()
      }, this.options.cancelGraceMs).unref()
      return
    }
  }

  private async disposeTask(task: PoolTask): Promise<void> {
    if (!task.terminal && !task.completed) {
      this.cancel(task.requestId, new DOMException("Agent turn consumer disposed", "AbortError"))
    }
  }

  private sweepHealth(now = Date.now()): void {
    if (this.stopping) return
    let liveWorkers = this.liveWorkerCount()
    const desiredWorkers = this.desiredWorkerCount()
    for (const worker of this.workers.values()) {
      if (liveWorkers <= desiredWorkers) break
      if (
        worker.stopping ||
        worker.task ||
        !worker.ready ||
        worker.idleSince === undefined ||
        now - worker.idleSince < this.options.idleTimeoutMs
      ) {
        continue
      }
      liveWorkers--
      this.recycle(worker, "idle_timeout")
    }
    for (const worker of this.workers.values()) {
      if (worker.stopping || now - worker.lastHeartbeatAt <= this.options.heartbeatTimeoutMs) continue
      worker.stopping = true
      this.log.warn("agent worker heartbeat timed out", {
        workerID: worker.id,
        pid: worker.pid,
        ageMs: now - worker.lastHeartbeatAt,
      })
      ObservabilityMetrics.record({
        name: "agent.worker.heartbeat_timeout",
        value: 1,
        unit: "count",
        module: "session",
        processId: worker.id,
        pid: worker.pid,
      })
      worker.host.process.kill()
    }
  }

  private terminateForMemory(worker: PoolWorker, memory: AgentTurnProtocol.WorkerMemory): void {
    if (worker.stopping || this.stopping) return
    worker.stopping = true
    const reason = memory.rssBytes >= this.options.maxRssBytes ? "rss" : "heap"
    this.log.warn("agent worker memory watermark exceeded", {
      workerID: worker.id,
      pid: worker.pid,
      rssBytes: memory.rssBytes,
      heapUsedBytes: memory.heapUsedBytes,
      reason,
    })
    ObservabilityMetrics.record({
      name: "agent.worker.recycle",
      value: 1,
      unit: "count",
      module: "session",
      processId: worker.id,
      pid: worker.pid,
      labels: { reason, turns: worker.turns, ...memory },
    })
    worker.host.process.kill()
  }

  private send(worker: PoolWorker, message: AgentTurnProtocol.HostToWorker): boolean {
    if (worker.stopping || this.stopping) return false
    try {
      worker.host.send(message)
      return true
    } catch (error) {
      worker.stopping = true
      this.log.warn("agent worker IPC send failed", {
        workerID: worker.id,
        pid: worker.pid,
        messageType: message.type,
        error,
      })
      worker.host.process.kill()
      return false
    }
  }

  private terminateForProtocol(worker: PoolWorker, reason: string): void {
    if (worker.stopping || this.stopping) return
    worker.startupFailureEligible = false
    worker.stopping = true
    this.log.warn("agent worker protocol violation", {
      workerID: worker.id,
      pid: worker.pid,
      reason,
    })
    worker.host.process.kill()
  }
}

export const DEFAULT_AGENT_WORKER_POOL_OPTIONS: AgentWorkerPoolOptions = {
  size: Math.max(1, Math.min(4, availableParallelism() - 1)),
  minIdle: 0,
  idleTimeoutMs: 60_000,
  maxQueued: 256,
  maxQueuedBytes: 256 * 1024 * 1024,
  maxTurns: 64,
  maxRssBytes: 1536 * 1024 * 1024,
  maxHeapBytes: 1024 * 1024 * 1024,
  idleBaselineRecycle: process.platform === "linux",
  idleBaselineRssGrowthBytes: 256 * 1024 * 1024,
  idleBaselineExternalGrowthBytes: 128 * 1024 * 1024,
  cancelGraceMs: 5_000,
  heartbeatTimeoutMs: 45_000,
}
