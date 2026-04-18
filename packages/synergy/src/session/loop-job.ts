import { MessageV2 } from "./message-v2"
import type { Info } from "./types"
import { Log } from "../util/log"

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
    modelLimits?: { context: number; output: number }
    modelID?: string
  }

  export interface JobInstance {
    type: string
    [key: string]: unknown
  }

  export interface Job {
    type: string
    phase: "pre" | "post"
    blocking: boolean
    signals?: string[]
    collect(ctx: Context): JobInstance[]
    execute(ctx: Context): Promise<FlowResult>
  }

  // --- Signal system ---

  export interface Signal {
    type: string
    detect(ctx: Context): Promise<boolean> | boolean
  }

  const registry = new Map<string, Job>()
  const signals = new Map<string, Signal>()

  export function register(job: Job) {
    registry.set(job.type, job)
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
    const nonBlocking: { instance: JobInstance; job: Job }[] = []
    const blocking: { instance: JobInstance; job: Job }[] = []
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
      job.execute(ctx).catch((e) => {
        log.error("job failed", { type: instance.type, error: e })
      })
    }
    let flow: FlowResult = "pass"
    for (const { instance, job } of blocking) {
      const result = await job.execute(ctx)
      if (result === "stop") return "stop"
      if (result === "continue") flow = "continue"
    }
    return flow
  }
}
