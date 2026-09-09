import { RolloutRecordingError } from "./rollout/error"
import { AsyncLocalStorage } from "node:async_hooks"
import { MessageV2 } from "./message-v2"
import type { Info } from "./types"
import { Log } from "../util/log"
import { ObservabilityMetrics } from "../observability/metrics"

export namespace LoopJob {
  const log = Log.create({ service: "session.loop-job" })

  export type FlowResult = "stop" | "continue" | "pass"

  export interface Context {
    session: Info
    sessionID: string
    step: number
    messages: MessageV2.WithParts[]
    lastUser: MessageV2.User
    lastUserParts: MessageV2.Part[]
    lastFinished?: MessageV2.Assistant
    lastFinishedParts?: MessageV2.Part[]
    lastAssistant?: MessageV2.Assistant
    abort: AbortSignal
    compactionAutoDisabled?: boolean
    compactionOverflowThreshold?: number
    compactionMaxHistoryImages?: number
    modelLimits?: { context: number; input?: number; output: number }
    modelID?: string
  }

  export interface JobInstance {
    type: string
    [key: string]: unknown
  }

  interface JobBase {
    type: string
    phase: "pre" | "post"
    signals?: string[]
    collect(ctx: Context): JobInstance[]
  }

  export interface BlockingJob extends JobBase {
    blocking: true
    execute(ctx: Context, instance: JobInstance): Promise<FlowResult>
  }

  export interface BackgroundJob<Payload extends JobInstance = JobInstance> extends JobBase {
    blocking: false
    capture(ctx: Context, instance: JobInstance): Payload
    key?(payload: Payload): string
    timeoutMs?: number
    execute(payload: Payload, signal: AbortSignal): Promise<FlowResult>
  }

  export type Job<Payload extends JobInstance = JobInstance> = BlockingJob | BackgroundJob<Payload>

  // --- Signal system ---

  export interface Signal {
    type: string
    detect(ctx: Context): Promise<boolean> | boolean
  }

  type RegisteredBackgroundJob = BackgroundJob<JobInstance>
  type RegisteredJob = BlockingJob | RegisteredBackgroundJob

  interface BackgroundRun {
    job: RegisteredBackgroundJob
    payload: JobInstance
    payloadBytes: number
    sessionID: string
    rootID: string
    abort: AbortSignal
    resume: ReturnType<typeof AsyncLocalStorage.snapshot>
  }

  interface BackgroundState {
    type: string
    key: string
    startedAt: number
    current: BackgroundRun
    pending?: BackgroundRun
    completion: Promise<void>
  }

  const registry = new Map<string, RegisteredJob>()
  const signals = new Map<string, Signal>()
  const background = new Map<string, BackgroundState>()
  const failures = new Map<string, InstanceType<typeof RolloutRecordingError>>()
  const ownerKey = (sessionID: string, rootID: string) => `${sessionID}:${rootID}`
  let backgroundSequence = 0
  const DEFAULT_BACKGROUND_TIMEOUT_MS = 180_000

  export function register<Payload extends JobInstance>(job: Job<Payload>) {
    registry.set(job.type, job as RegisteredJob)
  }

  export function defineSignal(signal: Signal) {
    signals.set(signal.type, signal)
  }

  export async function detectSignals(ctx: Context): Promise<string[]> {
    const fired: string[] = []
    for (const [type, signal] of signals) {
      if (await signal.detect(ctx)) {
        fired.push(type)
      }
    }
    return fired
  }

  export function collect(phase: "pre" | "post", ctx: Context, firedSignals: string[] = []): JobInstance[] {
    const instances: JobInstance[] = []
    for (const job of registry.values()) {
      if (job.phase !== phase) continue
      instances.push(...job.collect(ctx))
      if (firedSignals.length > 0 && job.signals) {
        for (const signal of firedSignals) {
          if (!job.signals.includes(signal)) continue
          const instance = { type: job.type, signal }
          if (instance) instances.push(instance)
        }
      }
    }
    return instances
  }

  export async function execute(instances: JobInstance[], ctx: Context): Promise<FlowResult> {
    const failure = failures.get(ownerKey(ctx.sessionID, ctx.lastUser.rootID ?? ctx.lastUser.id))
    if (failure) throw failure
    const nonBlocking: { instance: JobInstance; job: RegisteredBackgroundJob }[] = []
    const blocking: { instance: JobInstance; job: BlockingJob }[] = []
    for (const instance of instances) {
      const job = registry.get(instance.type)
      if (!job) {
        log.warn("no job registered", { type: instance.type })
        continue
      }
      if (job.blocking) blocking.push({ instance, job })
      else nonBlocking.push({ instance, job })
    }
    for (const { instance, job } of nonBlocking) {
      let payload: JobInstance
      try {
        payload = job.capture(ctx, instance)
      } catch (error) {
        log.error("failed to capture background job", { type: instance.type, error })
        continue
      }
      scheduleBackground(job, payload, ctx)
    }
    let flow: FlowResult = "pass"
    for (const { instance, job } of blocking) {
      const result = await job.execute(ctx, instance)
      if (result === "stop") return "stop"
      if (result === "continue") flow = "continue"
    }
    return flow
  }

  export async function drainAll() {
    while (background.size) await Promise.all([...background.values()].map((state) => state.completion))
    const errors = [...failures.values()]
    failures.clear()
    if (errors.length) throw new AggregateError(errors, "Background loop jobs failed during runtime shutdown")
  }

  export async function drain(sessionID: string, rootID?: string) {
    while (true) {
      const owned = [...background.values()].filter(
        (state) => state.current.sessionID === sessionID && (rootID === undefined || state.current.rootID === rootID),
      )
      if (!owned.length) break
      const settled = await Promise.allSettled(owned.map((state) => state.completion))
      const rejected = settled.find((result) => result.status === "rejected")
      if (rejected?.status === "rejected") throw rejected.reason
    }
    let failure: InstanceType<typeof RolloutRecordingError> | undefined
    for (const [key, error] of failures) {
      if (rootID === undefined ? key.startsWith(`${sessionID}:`) : key === ownerKey(sessionID, rootID)) {
        failure ??= error
        failures.delete(key)
      }
    }
    if (failure) throw failure
  }

  function scheduleBackground(job: RegisteredBackgroundJob, payload: JobInstance, ctx: Context) {
    const sessionID = ctx.sessionID
    const rootID = ctx.lastUser.rootID ?? ctx.lastUser.id
    const coalescingKey = job.key?.(payload)
    const key = `${ownerKey(sessionID, rootID)}:${job.type}:${coalescingKey ?? `run:${++backgroundSequence}`}`
    const run = {
      job,
      payload,
      payloadBytes: estimatePayloadBytes(payload),
      sessionID,
      rootID,
      abort: ctx.abort,
      resume: AsyncLocalStorage.snapshot(),
    }
    const current = background.get(key)
    if (current) {
      current.pending = run
      recordMetric("session.loop_job.background.coalesced", 1, "count", job.type, sessionID)
      recordMetric("session.loop_job.background.payload_bytes", run.payloadBytes, "bytes", job.type, sessionID, {
        state: "pending",
      })
      return
    }

    const state: BackgroundState = {
      type: job.type,
      key,
      startedAt: Date.now(),
      current: run,
      completion: Promise.resolve(),
    }
    background.set(key, state)
    recordMetric("session.loop_job.background.active", activeCount(job.type), "count", job.type, sessionID)
    state.completion = runBackground(state)
    void state.completion.catch((error) => log.error("background job finalization failed", { type: job.type, error }))
  }

  async function runBackground(state: BackgroundState) {
    let run: BackgroundRun | undefined = state.current
    while (run) {
      state.current = run
      state.startedAt = Date.now()
      recordMetric("session.loop_job.background.payload_bytes", run.payloadBytes, "bytes", state.type, run.sessionID, {
        state: "active",
      })
      let outcome = "success"
      try {
        await executeWithTimeout(run)
      } catch (error) {
        outcome = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "error"
        log.error("job failed", { type: state.type, outcome, error })
        if (RolloutRecordingError.isInstance(error)) {
          failures.set(ownerKey(run.sessionID, run.rootID), error)
          const { SessionManager } = await import("./manager")
          SessionManager.signalAbort(run.sessionID, { rootID: run.rootID })
          state.pending = undefined
          break
        }
      } finally {
        recordMetric(
          "session.loop_job.background.duration",
          Math.max(0, Date.now() - state.startedAt),
          "ms",
          state.type,
          run.sessionID,
          { outcome },
        )
      }
      run = state.pending
      state.pending = undefined
    }
    if (background.get(state.key) === state) background.delete(state.key)
    recordMetric(
      "session.loop_job.background.active",
      activeCount(state.type),
      "count",
      state.type,
      state.current.sessionID,
    )
  }

  async function executeWithTimeout(run: BackgroundRun) {
    const controller = new AbortController()
    const timeoutMs = backgroundTimeoutMs(run.job)
    const timeout = setTimeout(
      () => controller.abort(new DOMException(`Background job timed out after ${timeoutMs}ms.`, "TimeoutError")),
      timeoutMs,
    )
    timeout.unref()
    const signal = AbortSignal.any([controller.signal, run.abort])
    try {
      signal.throwIfAborted()
      const result = await run.resume(() => run.job.execute(run.payload, signal))
      signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timeout)
    }
  }

  function backgroundTimeoutMs(job: RegisteredBackgroundJob) {
    const timeoutMs = job.timeoutMs
    return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_BACKGROUND_TIMEOUT_MS
  }

  function activeCount(jobType: string) {
    let count = 0
    for (const state of background.values()) {
      if (state.type === jobType) count++
    }
    return count
  }

  function recordMetric(
    name: string,
    value: number,
    unit: "bytes" | "count" | "ms",
    jobType: string,
    sessionID?: string,
    labels: Record<string, unknown> = {},
  ) {
    ObservabilityMetrics.record({
      name,
      value,
      unit,
      module: "session",
      sessionID,
      labels: { jobType, ...labels },
    })
  }

  function estimatePayloadBytes(value: unknown) {
    const limit = 4 * 1024 * 1024
    const seen = new Set<object>()
    const stack = [value]
    let total = 0
    while (stack.length > 0 && total < limit) {
      const item = stack.pop()
      if (item === null || item === undefined) continue
      if (typeof item === "string") {
        total += item.length * 2
        continue
      }
      if (typeof item === "number" || typeof item === "bigint") {
        total += 8
        continue
      }
      if (typeof item === "boolean") {
        total += 4
        continue
      }
      if (typeof item !== "object" || seen.has(item)) continue
      seen.add(item)
      if (Array.isArray(item)) {
        total += item.length * 8
        stack.push(...item)
        continue
      }
      if (Object.getPrototypeOf(item) !== Object.prototype) {
        total += 64
        continue
      }
      const entries = Object.entries(item)
      total += entries.length * 16
      for (const [key, child] of entries) {
        total += key.length * 2
        stack.push(child)
      }
    }
    return Math.min(total, limit)
  }
}
