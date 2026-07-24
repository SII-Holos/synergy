import type { ModelMessage, Tool as AITool, ToolCallOptions } from "ai"
import { availableParallelism } from "os"
import { Log } from "@/util/log"
import { ObservabilityMetrics } from "@/observability/metrics"
import { SessionMemoryPressure } from "./memory-pressure"
import type { SessionProcessor } from "./processor"

export type ToolTaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
export type ToolExecutorKind = "local_process" | "file" | "plugin" | "mcp" | "browser" | "link" | "control_plane"

export interface ToolTaskResult {
  taskID: string
  state: ToolTaskState
  queuedAt: number
  startedAt?: number
  completedAt: number
  error?: string
  errorName?: string
}

export interface ToolTaskProcessor {
  message: { id: string }
  beginExecution(callID: string): SessionProcessor.ToolExecutionSlot
}

export interface ToolTaskInput {
  sessionID: string
  generation: number
  messageID: string
  callID: string
  attempt?: number
  toolName: string
  executor?: ToolExecutorKind
  input: unknown
  tool?: AITool
  processor: ToolTaskProcessor
  signal: AbortSignal
  onState?(state: ToolTaskState): void
}

export interface ToolTaskSchedulerOptions {
  maxConcurrent: number
  maxQueued: number
  maxQueuedBytes?: number
  shutdownGraceMs?: number
  executorConcurrency?: Partial<Record<ToolExecutorKind, number>>
}

interface QueuedTask {
  key: string
  input: ToolTaskInput
  queuedAt: number
  bytes: number
  settle(result: ToolTaskResult): boolean
  removeAbortListener(): void
}

export class ToolTaskScheduler {
  private readonly log = Log.create({ service: "tool.scheduler" })
  private readonly queue: QueuedTask[] = []
  private readonly tasks = new Map<string, Promise<ToolTaskResult>>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly activeTasks = new Map<string, QueuedTask>()
  private queuedBytes = 0
  private readonly terminalTasks: Array<{ key: string; promise: Promise<ToolTaskResult>; completedAt: number }> = []
  private active = 0
  private readonly activeByExecutor = new Map<ToolExecutorKind, number>()
  private stopping = false

  constructor(private readonly options: ToolTaskSchedulerOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
      throw new Error("Tool scheduler maxConcurrent must be a positive integer")
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error("Tool scheduler maxQueued must be a non-negative integer")
    }
  }

  dispatch(input: ToolTaskInput): Promise<ToolTaskResult> {
    this.sweepTerminal()
    const key = this.key(input)
    const existing = this.tasks.get(key)
    if (existing) return existing

    const queuedAt = Date.now()
    const taskBytes = Buffer.byteLength(JSON.stringify(input.input) ?? "", "utf8")
    let settle!: (result: ToolTaskResult) => void
    let settled = false
    const result = new Promise<ToolTaskResult>((resolve) => {
      settle = resolve
    })
    const settleOnce = (terminal: ToolTaskResult) => {
      if (settled) return false
      settled = true
      settle(terminal)
      return true
    }
    this.tasks.set(key, result)
    void result.then(() => {
      this.terminalTasks.push({ key, promise: result, completedAt: Date.now() })
    })
    input.onState?.("queued")

    if (this.stopping) {
      const terminal = this.terminal(input, "interrupted", queuedAt, undefined, "Tool scheduler is stopping")
      input.processor.beginExecution(input.callID).fail(input.input, terminal.error ?? "Tool scheduler is stopping")
      settleOnce(terminal)
      input.onState?.("interrupted")
      return result
    }
    if (input.signal.aborted) {
      const terminal = this.terminal(input, "cancelled", queuedAt, undefined, "Tool execution aborted")
      input.processor.beginExecution(input.callID).fail(input.input, terminal.error ?? "Tool execution aborted")
      settleOnce(terminal)
      input.onState?.("cancelled")
      return result
    }
    const executor = input.executor ?? "control_plane"
    const canStartImmediately =
      this.active < this.options.maxConcurrent && this.executorAvailable(executor) && this.queue.length === 0
    if (!canStartImmediately && this.queue.length >= this.options.maxQueued) {
      const error = `Tool execution queue is full (${this.options.maxQueued} waiting)`
      const terminal = this.terminal(input, "failed", queuedAt, undefined, error)
      input.processor.beginExecution(input.callID).fail(input.input, error)
      settleOnce(terminal)
      input.onState?.("failed")
      return result
    }
    const maxQueuedBytes = this.options.maxQueuedBytes ?? Number.POSITIVE_INFINITY
    if (!canStartImmediately && this.queuedBytes + taskBytes > maxQueuedBytes) {
      const error = `Tool execution queue exceeded ${maxQueuedBytes} bytes of waiting inputs`
      const terminal = this.terminal(input, "failed", queuedAt, undefined, error)
      input.processor.beginExecution(input.callID).fail(input.input, error)
      settleOnce(terminal)
      input.onState?.("failed")
      return result
    }

    const onAbort = () => {
      const index = this.queue.findIndex((task) => task.key === key)
      if (index === -1) {
        this.activeControllers.get(key)?.abort(input.signal.reason)
        return
      }
      const [task] = this.queue.splice(index, 1)
      this.queuedBytes -= task.bytes
      task.removeAbortListener()
      const terminal = this.terminal(input, "cancelled", queuedAt, undefined, "Tool execution aborted")
      input.processor.beginExecution(input.callID).fail(input.input, terminal.error ?? "Tool execution aborted")
      if (task.settle(terminal)) input.onState?.("cancelled")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })
    this.queue.push({
      key,
      input,
      queuedAt,
      bytes: taskBytes,
      settle: settleOnce,
      removeAbortListener: () => input.signal.removeEventListener("abort", onAbort),
    })
    this.queuedBytes += taskBytes
    ObservabilityMetrics.record({
      name: "tool.queue.depth",
      value: this.queue.length,
      unit: "count",
      module: "tool",
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      tool: input.toolName,
    })
    this.drain()
    return result
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      tracked: this.tasks.size,
      queuedBytes: this.queuedBytes,
      maxConcurrent: this.options.maxConcurrent,
      maxQueued: this.options.maxQueued,
      maxQueuedBytes: this.options.maxQueuedBytes,
      byExecutor: Object.fromEntries(
        (["local_process", "file", "plugin", "mcp", "browser", "link", "control_plane"] as ToolExecutorKind[]).map(
          (executor) => [
            executor,
            {
              active: this.activeByExecutor.get(executor) ?? 0,
              queued: this.queue.filter((task) => (task.input.executor ?? "control_plane") === executor).length,
              limit: this.options.executorConcurrency?.[executor] ?? this.options.maxConcurrent,
            },
          ],
        ),
      ),
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const queued = this.queue.splice(0)
    for (const task of queued) {
      this.queuedBytes -= task.bytes
      task.removeAbortListener()
      task.input.processor.beginExecution(task.input.callID).fail(task.input.input, "Tool scheduler stopped")
      task.settle(this.terminal(task.input, "interrupted", task.queuedAt, undefined, "Tool scheduler stopped"))
      task.input.onState?.("interrupted")
    }
    for (const controller of this.activeControllers.values()) controller.abort(new Error("Tool scheduler stopped"))
    const pending = [...this.activeTasks.values()]
    const settled = await Promise.race([
      Promise.allSettled([...this.tasks.values()]).then(() => true),
      Bun.sleep(this.options.shutdownGraceMs ?? 3_000).then(() => false),
    ])
    if (settled) return
    this.log.warn("tool scheduler shutdown grace elapsed", { active: pending.length })
    for (const task of pending) {
      const error = "Tool scheduler shutdown grace elapsed"
      const slot = task.input.processor.beginExecution(task.input.callID)
      if (slot.status === "pending") slot.fail(task.input.input, error)
      if (task.settle(this.terminal(task.input, "interrupted", task.queuedAt, undefined, error))) {
        task.input.onState?.("interrupted")
      }
    }
  }

  private drain(): void {
    while (!this.stopping && this.active < this.options.maxConcurrent && this.queue.length > 0) {
      const taskIndex = this.queue.findIndex((task) => this.executorAvailable(task.input.executor ?? "control_plane"))
      if (taskIndex === -1) return
      const [task] = this.queue.splice(taskIndex, 1)
      this.queuedBytes -= task.bytes
      task.removeAbortListener()
      this.active++
      const executor = task.input.executor ?? "control_plane"
      this.activeByExecutor.set(executor, (this.activeByExecutor.get(executor) ?? 0) + 1)
      void this.run(task).finally(() => {
        this.active--
        const remaining = (this.activeByExecutor.get(executor) ?? 1) - 1
        if (remaining > 0) this.activeByExecutor.set(executor, remaining)
        else this.activeByExecutor.delete(executor)
        this.activeControllers.delete(task.key)
        this.drain()
      })
    }
  }

  private async run(task: QueuedTask): Promise<void> {
    const startedAt = Date.now()
    this.activeTasks.set(task.key, task)
    ObservabilityMetrics.record({
      name: "tool.queue.wait",
      value: startedAt - task.queuedAt,
      unit: "ms",
      module: "tool",
      sessionID: task.input.sessionID,
      messageID: task.input.messageID,
      callID: task.input.callID,
      tool: task.input.toolName,
      labels: { executor: task.input.executor ?? "control_plane" },
    })
    task.input.onState?.("running")
    const controller = new AbortController()
    this.activeControllers.set(task.key, controller)
    const onAbort = () => controller.abort(task.input.signal.reason)
    task.input.signal.addEventListener("abort", onAbort, { once: true })
    const signal = AbortSignal.any([task.input.signal, controller.signal])
    const slot = task.input.processor.beginExecution(task.input.callID)

    try {
      const execute = task.input.tool?.execute
      if (!execute) throw new Error(`Tool "${task.input.toolName}" has no executable implementation`)
      const options = {
        toolCallId: task.input.callID,
        messages: [] as ModelMessage[],
        abortSignal: signal,
      } satisfies ToolCallOptions
      await execute(task.input.input, options)
      if (slot.status === "pending") {
        throw new Error(`Tool "${task.input.toolName}" completed without settling its result`)
      }
      if (task.settle(this.terminal(task.input, "completed", task.queuedAt, startedAt))) {
        task.input.onState?.("completed")
      }
    } catch (error) {
      const aborted = signal.aborted
      const message = aborted ? "Tool execution aborted" : error instanceof Error ? error.message : String(error)
      if (slot.status === "pending") slot.fail(task.input.input, message)
      const terminal = this.terminal(
        task.input,
        aborted ? "cancelled" : "failed",
        task.queuedAt,
        startedAt,
        message,
        error instanceof Error ? error.constructor.name : undefined,
      )
      if (task.settle(terminal)) task.input.onState?.(aborted ? "cancelled" : "failed")
      if (!aborted) {
        this.log.warn("tool task failed", {
          tool: task.input.toolName,
          callID: task.input.callID,
          sessionID: task.input.sessionID,
          error,
        })
      }
    } finally {
      ObservabilityMetrics.record({
        name: "tool.scheduler.duration",
        value: Date.now() - startedAt,
        unit: "ms",
        module: "tool",
        sessionID: task.input.sessionID,
        messageID: task.input.messageID,
        callID: task.input.callID,
        tool: task.input.toolName,
        labels: { executor: task.input.executor ?? "control_plane" },
      })
      task.input.signal.removeEventListener("abort", onAbort)
      this.activeTasks.delete(task.key)
      const memory = SessionMemoryPressure.currentSnapshot()
      const thresholds = SessionMemoryPressure.resolveThresholds(process.env, memory)
      if (SessionMemoryPressure.pressureLevel(memory, thresholds) !== "normal") {
        SessionMemoryPressure.signalRelease({
          phase: "tool.execution.complete",
          sessionID: task.input.sessionID,
          messageID: task.input.messageID,
          linuxOnly: true,
        })
      }
    }
  }

  private terminal(
    input: ToolTaskInput,
    state: ToolTaskState,
    queuedAt: number,
    startedAt?: number,
    error?: string,
    errorName?: string,
  ): ToolTaskResult {
    return {
      taskID: this.key(input),
      state,
      queuedAt,
      startedAt,
      completedAt: Date.now(),
      error,
      errorName,
    }
  }

  private key(input: ToolTaskInput): string {
    return JSON.stringify([
      input.sessionID,
      input.generation,
      input.messageID,
      input.callID,
      input.executor ?? "control_plane",
      input.attempt ?? 0,
    ])
  }

  private executorAvailable(executor: ToolExecutorKind): boolean {
    const limit = this.options.executorConcurrency?.[executor] ?? this.options.maxConcurrent
    return (this.activeByExecutor.get(executor) ?? 0) < limit
  }

  private sweepTerminal(now = Date.now()): void {
    const cutoff = now - 30 * 60 * 1000
    while (
      this.terminalTasks.length > 0 &&
      (this.terminalTasks[0].completedAt < cutoff || this.terminalTasks.length > 10_000)
    ) {
      const entry = this.terminalTasks.shift()!
      if (this.tasks.get(entry.key) === entry.promise) this.tasks.delete(entry.key)
    }
  }
}

const defaultConcurrency = Math.max(4, Math.min(32, availableParallelism() * 2))
const defaultOptions: ToolTaskSchedulerOptions = {
  maxConcurrent: defaultConcurrency,
  maxQueued: defaultConcurrency * 32,
  maxQueuedBytes: 128 * 1024 * 1024,
  shutdownGraceMs: 3_000,
  executorConcurrency: {
    local_process: Math.min(defaultConcurrency, 8),
    file: Math.min(defaultConcurrency, 16),
    plugin: Math.min(defaultConcurrency, 8),
    mcp: Math.min(defaultConcurrency, 16),
    browser: Math.min(defaultConcurrency, 8),
    link: Math.min(defaultConcurrency, 8),
    control_plane: defaultConcurrency,
  },
}

export namespace ToolScheduler {
  let options: ToolTaskSchedulerOptions = defaultOptions
  let scheduler: ToolTaskScheduler | undefined
  let accepting = true
  let stopPromise: Promise<void> | undefined

  export function configure(input: Partial<ToolTaskSchedulerOptions> = {}): void {
    if (scheduler) throw new Error("Tool scheduler cannot be reconfigured after it has started")
    accepting = true
    options = {
      ...defaultOptions,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      executorConcurrency: {
        ...defaultOptions.executorConcurrency,
        ...input.executorConcurrency,
      },
    }
  }

  export function dispatch(input: ToolTaskInput): Promise<ToolTaskResult> {
    if (!accepting) return Promise.reject(new Error("Tool scheduler is stopping"))
    scheduler ??= new ToolTaskScheduler(options)
    return scheduler.dispatch(input)
  }

  export function stats() {
    return (
      scheduler?.stats() ?? {
        active: 0,
        queued: 0,
        tracked: 0,
        maxConcurrent: options.maxConcurrent,
        maxQueued: options.maxQueued,
        maxQueuedBytes: options.maxQueuedBytes,
        queuedBytes: 0,
        byExecutor: {},
      }
    )
  }

  export async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    accepting = false
    const current = scheduler
    stopPromise = (async () => {
      await current?.stop()
      if (scheduler === current) scheduler = undefined
    })()
    try {
      await stopPromise
    } finally {
      stopPromise = undefined
    }
  }
}
