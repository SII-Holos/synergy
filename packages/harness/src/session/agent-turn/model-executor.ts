import { AsyncLocalStorage } from "node:async_hooks"
import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import { RolloutTransport } from "../rollout/transport"
import { CODEX_PROVIDER_ID, clearReplayPlan } from "../../provider/codex-compaction"
import { AgentTurnProtocol } from "./protocol"
import type { AgentTurnPoolInput, AgentTurnStream } from "./worker-pool"

type Options = { size: number; maxQueued: number; maxQueuedBytes: number }
type SDKPart = LLM.StreamOutput["fullStream"] extends AsyncIterable<infer Part> ? Part : never
type Task = {
  controller: AbortController
  bytes: number
  start(): Promise<void>
  reject(reason: unknown): void
  removeAbort(): void
  done: PromiseWithResolvers<void>
  close?: () => Promise<void>
}

/** Owns provider streams until consumption or confirmed disposal, without an IPC buffer. */
export class InProcessModelExecutor {
  private readonly queue: Task[] = []
  private readonly active = new Set<Task>()
  private queuedBytes = 0
  private stopping = false
  private stopPromise?: Promise<void>
  private readonly failures: unknown[] = []

  constructor(
    private options: Options,
    private readonly stream: (input: LLM.StreamInput) => Promise<LLM.StreamOutput> = LLM.stream,
  ) {
    this.resize(options.size)
    if (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0)
      throw new Error("Model queue maxQueued must be a non-negative integer")
    if (!Number.isSafeInteger(options.maxQueuedBytes) || options.maxQueuedBytes <= 0)
      throw new Error("Model queue maxQueuedBytes must be a positive integer")
  }

  resize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Model concurrency must be a positive integer")
    this.options = { ...this.options, size }
    this.drain()
  }

  run(input: AgentTurnPoolInput): Promise<AgentTurnStream> {
    if (this.stopping) return Promise.reject(new Error("Model executor is stopping"))
    if (input.abort.aborted) return Promise.reject(input.abort.reason)
    if (this.active.size >= this.options.size && this.queue.length >= this.options.maxQueued)
      return Promise.reject(new Error("Model queue is full"))
    const { abort, archive, onPhase, ...payload } = input
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    if (bytes + this.queuedBytes > this.options.maxQueuedBytes)
      return Promise.reject(new Error(`Model queue exceeded ${this.options.maxQueuedBytes} bytes`))

    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const done = Promise.withResolvers<void>()
      // Failed disposal is reported to its caller and to stop(), not as an unhandled rejection.
      void done.promise.catch(() => {})
      const cancel = () => {
        controller.abort(abort.reason)
        const index = this.queue.indexOf(task)
        if (index !== -1) {
          this.queue.splice(index, 1)
          this.queuedBytes -= bytes
          task.removeAbort()
          reject(controller.signal.reason)
          done.resolve()
        } else if (task.close) void task.close().catch(() => {})
      }
      const task: Task = {
        controller,
        bytes,
        reject,
        removeAbort: () => abort.removeEventListener("abort", cancel),
        done,
        start: AsyncLocalStorage.bind(async () => {
          let owned: ReturnType<typeof LLM.takeFullStream> | undefined
          let reader: ReadableStreamDefaultReader<SDKPart> | undefined
          let result: LLM.StreamOutput | undefined
          const usage = Promise.withResolvers<Awaited<AgentTurnStream["usage"]>>()
          let complete = false
          let closing: Promise<void> | undefined
          const finish = AsyncLocalStorage.bind(
            () =>
              (closing ??= (async () => {
                try {
                  if (!complete) {
                    controller.abort(new DOMException("Model stream disposed", "AbortError"))
                    await reader?.cancel(controller.signal.reason)
                  }
                  await owned?.dispose()
                  // Reading SDK usage early starts an eager tee consumer and defeats stream backpressure.
                  usage.resolve(complete ? await result?.usage.catch(() => undefined) : undefined)
                  done.resolve()
                } catch (error) {
                  this.stopping = true
                  this.failures.push(error)
                  this.rejectQueued(error)
                  usage.resolve(undefined)
                  done.reject(error)
                  throw error
                } finally {
                  if (input.model?.providerID === CODEX_PROVIDER_ID) clearReplayPlan(input.sessionID)
                  reader?.releaseLock()
                  task.removeAbort()
                  this.active.delete(task)
                  this.drain()
                }
              })()),
          )
          try {
            controller.signal.throwIfAborted()
            const open = () =>
              this.stream({
                ...payload,
                abort: controller.signal,
                tools: ToolCatalog.modelTools(input.toolDefinitions),
              })
            result = await (archive ? RolloutTransport.provide(archive, open) : open())
            owned = LLM.takeFullStream(result)
            reader = owned.stream.getReader()
            task.close = AsyncLocalStorage.bind(finish)
            controller.signal.throwIfAborted()
            onPhase?.("waiting_model")
            const fullStream = (async function* () {
              try {
                while (true) {
                  controller.signal.throwIfAborted()
                  const next = await reader!.read()
                  controller.signal.throwIfAborted()
                  if (next.done) {
                    complete = true
                    return
                  }
                  yield* AgentTurnProtocol.projectEvents([next.value])
                }
              } finally {
                await finish()
              }
            })()
            resolve({ fullStream, usage: usage.promise, dispose: task.close })
          } catch (error) {
            try {
              await finish()
            } catch (disposalError) {
              reject(new AggregateError([error, disposalError], "Model initialization and disposal failed"))
              return
            }
            reject(error)
          }
        }),
      }
      abort.addEventListener("abort", cancel, { once: true })
      this.queue.push(task)
      this.queuedBytes += bytes
      this.drain()
    })
  }

  private drain(): void {
    while (!this.stopping && this.active.size < this.options.size && this.queue.length) {
      const task = this.queue.shift()!
      this.queuedBytes -= task.bytes
      this.active.add(task)
      void task.start()
    }
  }

  private rejectQueued(reason: unknown): void {
    for (const task of this.queue.splice(0)) {
      task.removeAbort()
      task.controller.abort(reason)
      task.reject(reason)
      task.done.resolve()
    }
    this.queuedBytes = 0
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    const reason = new Error("Model executor is stopping")
    this.rejectQueued(reason)
    const tasks = [...this.active]
    for (const task of tasks) {
      task.controller.abort(reason)
      if (task.close) void task.close().catch(() => {})
    }
    return (this.stopPromise = (async () => {
      const results = await Promise.allSettled(tasks.map((task) => task.done.promise))
      const errors = [
        ...new Set([...this.failures, ...results.filter((r) => r.status === "rejected").map((r) => r.reason)]),
      ]
      if (errors.length) throw new AggregateError(errors, "Model streams failed to stop")
    })())
  }

  stats() {
    return {
      configured: this.options.size,
      minIdle: 0,
      idleTimeoutMs: 0,
      maxQueued: this.options.maxQueued,
      maxQueuedBytes: this.options.maxQueuedBytes,
      workers: 0,
      ready: 0,
      active: this.active.size,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      rssBytes: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      baselineBytes: 0,
      peakBytes: 0,
      retainedBytes: 0,
      measuredWorkers: 0,
      lastRecovery: undefined,
    }
  }
}
