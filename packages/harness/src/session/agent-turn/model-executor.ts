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
  start(): Promise<void>
  reject(reason: unknown): void
  removeAbort(): void
  done: PromiseWithResolvers<void>
  close?: () => Promise<void>
}

/** Owns provider streams until consumption or confirmed disposal, without an IPC buffer. */
export class InProcessModelExecutor {
  private readonly active = new Set<Task>()
  private stopping = false
  private stopPromise?: Promise<void>
  private readonly failures: unknown[] = []

  constructor(
    private options: Options,
    private readonly stream: (input: LLM.StreamInput) => Promise<LLM.StreamOutput> = LLM.stream,
  ) {
    this.resize(options.size)
  }

  resize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Model concurrency must be a positive integer")
    this.options = { ...this.options, size }
  }

  run(input: AgentTurnPoolInput): Promise<AgentTurnStream> {
    if (this.stopping) return Promise.reject(new Error("Model executor is stopping"))
    if (input.abort.aborted) return Promise.reject(input.abort.reason)
    const { abort, archive, onPhase, ...payload } = input
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const done = Promise.withResolvers<void>()
      // Failed disposal is reported to its caller and to stop(), not as an unhandled rejection.
      void done.promise.catch(() => {})
      const cancel = () => {
        controller.abort(abort.reason)
        if (task.close) void task.close().catch(() => {})
      }
      const task: Task = {
        controller,
        reject,
        removeAbort: () => abort.removeEventListener("abort", cancel),
        done,
        start: AsyncLocalStorage.bind(async () => {
          let owned: ReturnType<typeof LLM.takeFullStream> | undefined
          let reader: ReadableStreamDefaultReader<SDKPart> | undefined
          let result: LLM.StreamOutput | undefined
          const usage = Promise.withResolvers<Awaited<AgentTurnStream["usage"]>>()
          let complete = false
          let errored = false
          let closing: Promise<void> | undefined
          const finish = AsyncLocalStorage.bind(
            () =>
              (closing ??= (async () => {
                try {
                  if (!complete) {
                    controller.abort(new DOMException("Model stream disposed", "AbortError"))
                    await reader?.cancel(controller.signal.reason).catch((error) => {
                      // An errored stream rejects cancellation with its read error despite already being terminal.
                      if (!errored) throw error
                    })
                  }
                  await owned?.dispose()
                  // Reading SDK usage early starts an eager tee consumer and defeats stream backpressure.
                  usage.resolve(complete ? await Promise.resolve(result?.usage).catch(() => undefined) : undefined)
                  done.resolve()
                } catch (error) {
                  this.stopping = true
                  this.failures.push(error)
                  usage.resolve(undefined)
                  done.reject(error)
                  throw error
                } finally {
                  if (input.model?.providerID === CODEX_PROVIDER_ID) clearReplayPlan(input.sessionID)
                  reader?.releaseLock()
                  task.removeAbort()
                  this.active.delete(task)
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
            void reader.closed.catch(() => {
              errored = true
            })
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
      this.active.add(task)
      void task.start()
    })
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    const reason = new Error("Model executor is stopping")
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
      queued: 0,
      queuedBytes: 0,
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
