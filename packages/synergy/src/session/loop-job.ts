import { MessageV2 } from "./message-v2"
import type { Info } from "./types"
import { Log } from "../util/log"
import { ObservabilityMetrics } from "@/observability/metrics"

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
    execute(payload: Payload): Promise<FlowResult>
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
    sessionID?: string
  }

  interface BackgroundState {
    type: string
    key: string
    startedAt: number
    current: BackgroundRun
    pending?: BackgroundRun
  }

  const registry = new Map<string, RegisteredJob>()
  const signals = new Map<string, Signal>()
  const background = new Map<string, BackgroundState>()

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
      scheduleBackground(job, payload, ctx.sessionID)
    }
    let flow: FlowResult = "pass"
    for (const { instance, job } of blocking) {
      const result = await job.execute(ctx, instance)
      if (result === "stop") return "stop"
      if (result === "continue") flow = "continue"
    }
    return flow
  }

  export function backgroundStats() {
    return {
      active: background.size,
      jobs: [...background.values()].map((state) => ({
        type: state.type,
        key: state.key,
        ageMs: Math.max(0, Date.now() - state.startedAt),
        payloadBytes: state.current.payloadBytes,
        pending: state.pending !== undefined,
        pendingPayloadBytes: state.pending?.payloadBytes,
        sessionID: state.current.sessionID,
      })),
    }
  }

  function scheduleBackground(job: RegisteredBackgroundJob, payload: JobInstance, fallbackSessionID: string) {
    const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : fallbackSessionID
    const key = `${job.type}:${job.key?.(payload) ?? sessionID}`
    const run = {
      job,
      payload,
      payloadBytes: estimatePayloadBytes(payload),
      sessionID,
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
    }
    background.set(key, state)
    recordMetric("session.loop_job.background.active", background.size, "count", job.type, sessionID)
    void runBackground(state)
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
        await run.job.execute(run.payload)
      } catch (error) {
        outcome = "error"
        log.error("job failed", { type: state.type, error })
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
    recordMetric("session.loop_job.background.active", background.size, "count", state.type, state.current.sessionID)
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
