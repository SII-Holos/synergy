import { availableParallelism } from "os"
import { ObservabilityMetrics } from "@/observability/metrics"
import { Log } from "@/util/log"
import {
  spawnPolicyWorkerProcess,
  type PolicyWorkerProcess,
  type SpawnPolicyWorkerProcessOptions,
} from "./process-host"
import { PolicyWorkerProtocol, type PolicyClassificationInput } from "./protocol"
import type { ClassifyResult } from "../gate"

export interface PolicyWorkerPoolOptions {
  size: number
  maxQueued: number
  maxQueuedBytes: number
  timeoutMs: number
  maxRequests: number
  maxRssBytes: number
  maxHeapBytes: number
  cancelGraceMs: number
  heartbeatTimeoutMs: number
}

export interface PolicyWorkerSupervisorOptions {
  startupBackoffBaseMs: number
  startupBackoffMaxMs: number
  maxConsecutiveStartupFailures: number
  sleep(ms: number): Promise<void>
}

const DEFAULT_POLICY_WORKER_SUPERVISOR_OPTIONS: PolicyWorkerSupervisorOptions = {
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
  transferCommitted: boolean
  completed: boolean
  signal?: AbortSignal
  timer: ReturnType<typeof setTimeout>
  worker?: PoolWorker
  resolve(result: ClassifyResult): void
  reject(error: unknown): void
  removeAbortListener(): void
}

interface PoolWorker {
  id: string
  host: PolicyWorkerProcess
  ready: boolean
  startupFailureEligible: boolean
  stopping: boolean
  task?: PoolTask
  requests: number
  pid?: number
  rssBytes?: number
  heapUsedBytes?: number
  lastHeartbeatAt: number
}

export class PolicyWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Policy classification exceeded ${timeoutMs}ms`)
    this.name = "PolicyWorkerTimeoutError"
  }
}

export class PolicyWorkerPool {
  private readonly log = Log.create({ service: "policy.worker.pool" })
  private readonly workers = new Map<string, PoolWorker>()
  private readonly queue: PoolTask[] = []
  private queuedBytes = 0
  private stopping = false
  private readonly healthTimer: ReturnType<typeof setInterval>
  private readonly supervisor: PolicyWorkerSupervisorOptions
  private consecutiveStartupFailures = 0
  private startupRetryGeneration = 0
  private startupCircuitError: Error | undefined
  private startupRetryPending = false

  constructor(
    private readonly options: PolicyWorkerPoolOptions,
    private readonly spawn: (
      options: SpawnPolicyWorkerProcessOptions,
    ) => PolicyWorkerProcess = spawnPolicyWorkerProcess,
    supervisor: Partial<PolicyWorkerSupervisorOptions> = {},
  ) {
    this.supervisor = { ...DEFAULT_POLICY_WORKER_SUPERVISOR_OPTIONS, ...supervisor }
    if (!Number.isInteger(options.size) || options.size <= 0) {
      throw new Error("Policy worker pool size must be a positive integer")
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error("Policy worker pool maxQueued must be a non-negative integer")
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Policy worker timeout must be a positive integer")
    }
    this.healthTimer = setInterval(() => this.sweepHealth(), Math.min(5_000, options.heartbeatTimeoutMs))
    this.healthTimer.unref()
  }

  start(): void {
    if (this.stopping) throw new Error("Policy worker pool is stopping")
    this.ensureWorkers()
  }

  run(input: PolicyClassificationInput, signal?: AbortSignal): Promise<ClassifyResult> {
    if (this.stopping) return Promise.reject(new Error("Policy worker pool is stopping"))
    if (this.startupCircuitError) return Promise.reject(this.startupCircuitError)
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Policy classification aborted", "AbortError"))
    }

    const payload = PolicyWorkerProtocol.serializeInput(input)
    const requestBytes = payload.byteLength
    this.ensureWorkers()
    if (this.startupCircuitError) return Promise.reject(this.startupCircuitError)
    const unassignedWorkers = [...this.workers.values()].filter((worker) => !worker.stopping && !worker.task).length
    const waitingTasks = Math.max(0, this.queue.length - unassignedWorkers)
    if (waitingTasks >= this.options.maxQueued && this.queue.length >= unassignedWorkers) {
      return Promise.reject(new Error(`Policy worker queue is full (${this.options.maxQueued} waiting)`))
    }
    if (this.queuedBytes + requestBytes > this.options.maxQueuedBytes && !this.availableWorker()) {
      return Promise.reject(
        new Error(`Policy worker queue exceeded ${this.options.maxQueuedBytes} bytes of waiting requests`),
      )
    }

    return new Promise<ClassifyResult>((resolve, reject) => {
      const requestId = `policy_${crypto.randomUUID()}`
      const onAbort = () => this.abort(requestId, signal?.reason)
      signal?.addEventListener("abort", onAbort, { once: true })
      const task: PoolTask = {
        requestId,
        queuedAt: Date.now(),
        requestBytes,
        payload,
        nextChunk: 0,
        transferCommitted: false,
        completed: false,
        signal,
        timer: setTimeout(() => this.timeout(requestId), this.options.timeoutMs),
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      }
      task.timer.unref()
      this.queue.push(task)
      this.queuedBytes += requestBytes
      ObservabilityMetrics.record({
        name: "policy.queue.depth",
        value: this.queue.length,
        unit: "count",
        module: "enforcement",
      })
      this.drain()
    })
  }

  stats() {
    let ready = 0
    let active = 0
    for (const worker of this.workers.values()) {
      if (worker.ready) ready++
      if (worker.task) active++
    }
    return {
      configured: this.options.size,
      maxQueued: this.options.maxQueued,
      maxQueuedBytes: this.options.maxQueuedBytes,
      workers: this.workers.size,
      ready,
      active,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      rssBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.rssBytes ?? 0), 0),
      heapUsedBytes: [...this.workers.values()].reduce((sum, worker) => sum + (worker.heapUsedBytes ?? 0), 0),
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.healthTimer)
    this.startupRetryGeneration++
    this.startupRetryPending = false
    const error = new Error("Policy worker pool stopped")
    for (const task of this.queue.splice(0)) {
      this.queuedBytes -= task.requestBytes
      this.failTask(task, error)
    }
    for (const worker of this.workers.values()) {
      worker.stopping = true
      if (worker.task) this.failTask(worker.task, error)
    }
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.host.stop(this.options.cancelGraceMs)))
    this.workers.clear()
  }

  private ensureWorkers(): void {
    if (this.startupRetryPending) return
    while (!this.stopping && this.workers.size < this.options.size) {
      if (this.startupCircuitError || !this.spawnWorker()) return
    }
  }

  private spawnWorker(): boolean {
    const id = `policy_worker_${crypto.randomUUID()}`
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
        requests: 0,
        lastHeartbeatAt: Date.now(),
      }
      this.workers.set(id, worker)
      return true
    } catch (error) {
      this.handleStartupFailure(error)
      return false
    }
  }

  private onMessage(worker: PoolWorker, message: PolicyWorkerProtocol.WorkerToHost): void {
    if (message.type === "ready") {
      if (worker.ready || worker.task || message.protocolVersion !== PolicyWorkerProtocol.VERSION) {
        this.terminateWorker(worker, new Error("Policy worker sent an unexpected or incompatible ready message"))
        return
      }
      worker.ready = true
      worker.startupFailureEligible = false
      worker.pid = message.pid
      worker.lastHeartbeatAt = Date.now()
      this.consecutiveStartupFailures = 0
      this.startupCircuitError = undefined
      this.ensureWorkers()
      this.drain()
      return
    }

    if (message.type === "heartbeat") {
      if (message.requestId !== undefined && message.requestId !== worker.task?.requestId) {
        this.terminateWorker(worker, new Error("Policy worker heartbeat referenced an unowned request"))
        return
      }
      worker.requests = message.requests
      worker.rssBytes = message.memory.rssBytes
      worker.heapUsedBytes = message.memory.heapUsedBytes
      worker.lastHeartbeatAt = Date.now()
      if (
        message.memory.rssBytes >= this.options.maxRssBytes ||
        message.memory.heapUsedBytes >= this.options.maxHeapBytes
      ) {
        this.terminateWorker(worker, new Error("Policy worker exceeded its memory watermark"))
      }
      return
    }

    if (message.type === "pong") return
    const task = worker.task
    if (!task || message.requestId !== task.requestId) {
      this.terminateWorker(worker, new Error("Policy worker message referenced an unowned request"))
      return
    }

    if (message.type === "run-ready") {
      if (task.nextChunk !== 0 || task.transferCommitted) {
        this.terminateWorker(worker, new Error("Policy worker sent an unexpected run-ready message"))
        return
      }
      this.sendNextChunk(worker, task)
      return
    }

    if (message.type === "chunk-ack") {
      if (task.transferCommitted || message.index !== task.nextChunk - 1) {
        this.terminateWorker(worker, new Error("Policy worker sent an invalid chunk acknowledgement"))
        return
      }
      this.sendNextChunk(worker, task)
      return
    }

    if (message.type === "error") {
      const error = PolicyWorkerProtocol.deserializeError(message.error)
      this.failTask(task, error)
      this.releaseWorker(worker, task, false)
      this.terminateWorker(worker, error)
      return
    }

    worker.requests = message.requests
    worker.rssBytes = message.memory.rssBytes
    worker.heapUsedBytes = message.memory.heapUsedBytes
    task.resolve(message.result)
    this.completeTask(task)
    const recycle =
      message.requests >= this.options.maxRequests ||
      message.memory.rssBytes >= this.options.maxRssBytes ||
      message.memory.heapUsedBytes >= this.options.maxHeapBytes
    this.releaseWorker(worker, task, !recycle)
    if (recycle) this.recycleWorker(worker)
  }

  private onExit(worker: PoolWorker, exitCode: number | null, signal: string | null): void {
    this.workers.delete(worker.id)
    const error = new Error(`Policy worker exited (${exitCode ?? signal ?? "unknown"})`)
    const startupFailure = worker.startupFailureEligible && !worker.stopping
    const task = worker.task
    if (task) this.failTask(task, error)
    if (!this.stopping && !worker.stopping) {
      this.log.warn("policy worker exited", { workerID: worker.id, exitCode, signal })
      ObservabilityMetrics.record({
        name: "policy.worker.crash",
        value: 1,
        unit: "count",
        module: "enforcement",
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
    this.ensureWorkers()
    this.drain()
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
    this.log.warn("policy worker failed to start; retrying", { failures, delayMs, cause })
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
    const error = new Error(`Policy worker failed to start after ${attempts} consecutive attempts`, { cause })
    this.startupCircuitError = error
    this.startupRetryPending = false
    this.startupRetryGeneration++
    this.log.error("policy worker startup circuit opened", { attempts, cause })
    ObservabilityMetrics.record({
      name: "policy.worker.startup_circuit_open",
      value: 1,
      unit: "count",
      module: "enforcement",
      labels: { attempts },
    })
    for (const task of this.queue.splice(0)) {
      this.queuedBytes -= task.requestBytes
      this.failTask(task, error)
    }
  }

  private drain(): void {
    if (this.stopping) return
    for (const worker of this.workers.values()) {
      if (!worker.ready || worker.stopping || worker.task) continue
      const task = this.queue.shift()
      if (!task) return
      this.queuedBytes -= task.requestBytes
      if (task.completed) continue
      if (task.signal?.aborted) {
        this.failTask(task, task.signal.reason ?? new DOMException("Policy classification aborted", "AbortError"))
        continue
      }
      task.worker = worker
      task.startedAt = Date.now()
      worker.task = task
      this.send(worker, {
        type: "run-start",
        requestId: task.requestId,
        totalBytes: task.payload.byteLength,
        chunkCount: Math.ceil(task.payload.byteLength / PolicyWorkerProtocol.REQUEST_CHUNK_BYTES),
      })
      ObservabilityMetrics.record({
        name: "policy.queue.wait",
        value: task.startedAt - task.queuedAt,
        unit: "ms",
        module: "enforcement",
        processId: worker.id,
        pid: worker.pid,
      })
    }
  }

  private sendNextChunk(worker: PoolWorker, task: PoolTask): void {
    if (worker.task !== task || task.completed) return
    const start = task.nextChunk * PolicyWorkerProtocol.REQUEST_CHUNK_BYTES
    if (start >= task.payload.byteLength) {
      task.transferCommitted = true
      this.send(worker, { type: "run-commit", requestId: task.requestId })
      task.payload = new Uint8Array()
      return
    }
    const end = Math.min(start + PolicyWorkerProtocol.REQUEST_CHUNK_BYTES, task.payload.byteLength)
    const index = task.nextChunk++
    this.send(worker, {
      type: "run-chunk",
      requestId: task.requestId,
      index,
      data: task.payload.subarray(start, end),
    })
  }

  private send(worker: PoolWorker, message: PolicyWorkerProtocol.HostToWorker): void {
    if (worker.stopping || this.stopping) return
    try {
      worker.host.send(message)
    } catch (error) {
      this.terminateWorker(worker, error)
    }
  }

  private timeout(requestId: string): void {
    const task = this.findTask(requestId)
    if (!task || task.completed) return
    const error = new PolicyWorkerTimeoutError(this.options.timeoutMs)
    ObservabilityMetrics.record({
      name: "policy.worker.timeout",
      value: 1,
      unit: "count",
      module: "enforcement",
      processId: task.worker?.id,
      pid: task.worker?.pid,
    })
    if (task.worker) {
      this.terminateWorker(task.worker, error)
      return
    }
    this.removeQueuedTask(task)
    this.failTask(task, error)
    const unreadyWorker = [...this.workers.values()].find((worker) => !worker.ready && !worker.stopping)
    if (unreadyWorker) this.terminateWorker(unreadyWorker, error)
  }

  private abort(requestId: string, reason?: unknown): void {
    const task = this.findTask(requestId)
    if (!task || task.completed) return
    const error = reason ?? new DOMException("Policy classification aborted", "AbortError")
    if (task.worker) {
      this.terminateWorker(task.worker, error)
      return
    }
    this.removeQueuedTask(task)
    this.failTask(task, error)
  }

  private findTask(requestId: string): PoolTask | undefined {
    const queued = this.queue.find((task) => task.requestId === requestId)
    if (queued) return queued
    for (const worker of this.workers.values()) {
      if (worker.task?.requestId === requestId) return worker.task
    }
    return undefined
  }

  private removeQueuedTask(task: PoolTask): void {
    const index = this.queue.indexOf(task)
    if (index === -1) return
    this.queue.splice(index, 1)
    this.queuedBytes -= task.requestBytes
  }

  private completeTask(task: PoolTask): void {
    if (task.completed) return
    task.completed = true
    clearTimeout(task.timer)
    task.removeAbortListener()
    if (task.startedAt !== undefined) {
      ObservabilityMetrics.record({
        name: "policy.classification.duration",
        value: Date.now() - task.startedAt,
        unit: "ms",
        module: "enforcement",
        processId: task.worker?.id,
        pid: task.worker?.pid,
      })
    }
  }

  private failTask(task: PoolTask, error: unknown): void {
    if (task.completed) return
    task.reject(error)
    this.completeTask(task)
  }

  private releaseWorker(worker: PoolWorker, task: PoolTask, drain = true): void {
    if (worker.task === task) worker.task = undefined
    task.worker = undefined
    if (drain) this.drain()
  }

  private terminateWorker(worker: PoolWorker, error: unknown): void {
    if (worker.stopping) return
    worker.stopping = true
    worker.ready = false
    this.workers.delete(worker.id)
    if (worker.task) {
      const task = worker.task
      worker.task = undefined
      this.failTask(task, error)
    }
    worker.host.process.kill()
    if (!this.stopping) {
      this.ensureWorkers()
      this.drain()
    }
  }

  private recycleWorker(worker: PoolWorker): void {
    if (worker.stopping || this.stopping) return
    worker.stopping = true
    worker.ready = false
    this.workers.delete(worker.id)
    ObservabilityMetrics.record({
      name: "policy.worker.recycle",
      value: 1,
      unit: "count",
      module: "enforcement",
      processId: worker.id,
      pid: worker.pid,
      labels: {
        requests: worker.requests,
        rssBytes: worker.rssBytes,
        heapUsedBytes: worker.heapUsedBytes,
      },
    })
    void worker.host.stop(this.options.cancelGraceMs)
    this.ensureWorkers()
  }

  private sweepHealth(now = Date.now()): void {
    if (this.stopping) return
    for (const worker of this.workers.values()) {
      if (worker.stopping || now - worker.lastHeartbeatAt <= this.options.heartbeatTimeoutMs) continue
      this.terminateWorker(worker, new Error("Policy worker heartbeat timed out"))
    }
  }

  private availableWorker(): boolean {
    return [...this.workers.values()].some((worker) => worker.ready && !worker.stopping && !worker.task)
  }
}

const defaultSize = Math.min(2, Math.max(1, availableParallelism() - 1))

export const DEFAULT_POLICY_WORKER_POOL_OPTIONS: PolicyWorkerPoolOptions = {
  size: defaultSize,
  maxQueued: 256,
  maxQueuedBytes: 64 * 1024 * 1024,
  timeoutMs: 1_000,
  maxRequests: 512,
  maxRssBytes: 512 * 1024 * 1024,
  maxHeapBytes: 256 * 1024 * 1024,
  cancelGraceMs: 25,
  heartbeatTimeoutMs: 15_000,
}
