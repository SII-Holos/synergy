import { RuntimeContext } from "../../lifecycle/context"
import { Log } from "../../util/log"
import type { GateOptions, ClassifyResult } from "../gate"
import type { PolicyClassificationContext } from "./protocol"
import { DEFAULT_POLICY_WORKER_POOL_OPTIONS, PolicyWorkerPool, type PolicyWorkerPoolOptions } from "./worker-pool"

export namespace PolicyWorker {
  const runtimeState = RuntimeContext.state(() => ({
    pool: undefined as PolicyWorkerPool | undefined,
    options: DEFAULT_POLICY_WORKER_POOL_OPTIONS,
    accepting: true,
    stopPromise: undefined as Promise<void> | undefined,
  }))

  const log = Log.create({ service: "policy.worker" })

  export function configure(input: Partial<PolicyWorkerPoolOptions> = {}): void {
    const instanceState = runtimeState()

    if (instanceState.pool) throw new Error("Policy worker pool cannot be reconfigured after it has started")
    instanceState.accepting = true
    instanceState.options = {
      ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    }
  }

  export function closeAdmission(): void {
    const instanceState = runtimeState()

    instanceState.accepting = false
  }

  export function context(options: GateOptions): PolicyClassificationContext {
    return {
      activeWorkspace: options.activeWorkspace,
      workspaceType: options.workspaceType,
      registeredMcpTools: [...(options.registeredMcpTools ?? [])],
      registeredPluginTools: [...(options.registeredPluginTools ?? [])],
      pluginToolCapabilities: options.pluginToolCapabilities ?? {},
      pluginApprovals: options.pluginApprovals
        ? Object.fromEntries(
            Object.entries(options.pluginApprovals).map(([pluginId, approval]) => [
              pluginId,
              { approvedCapabilities: approval.approvedCapabilities },
            ]),
          )
        : undefined,
      originalCheckout: options.originalCheckout,
      readRoots: options.readRoots,
      trustedRoots: options.trustedRoots,
      synergyRoot: options.synergyRoot,
    }
  }

  export function prewarm(): void {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise) return
    try {
      instanceState.pool ??= new PolicyWorkerPool(instanceState.options)
      instanceState.pool.start()
    } catch (error) {
      // Option validation cannot succeed in any later attempt either; log it
      // and let the first classification surface the failure through lazy creation.
      log.warn("policy worker pool prewarm rejected the configured options", { error })
    }
  }

  export async function start(): Promise<void> {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise) throw new Error("Policy worker pool is stopping")
    instanceState.pool ??= new PolicyWorkerPool(instanceState.options)
    instanceState.pool.start()
    await instanceState.pool.ready()
  }

  export async function classify(input: {
    context: PolicyClassificationContext
    toolName: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<ClassifyResult> {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise)
      return Promise.reject(new Error("Policy worker pool is stopping"))
    instanceState.pool ??= new PolicyWorkerPool(instanceState.options)
    instanceState.pool.start()
    await instanceState.pool.ready(input.signal)
    return await instanceState.pool.run(
      {
        context: input.context,
        toolName: input.toolName,
        args: input.args,
      },
      input.signal,
    )
  }

  export function stats() {
    const instanceState = runtimeState()

    return (
      instanceState.pool?.stats() ?? {
        configured: instanceState.options.size,
        maxQueued: instanceState.options.maxQueued,
        maxQueuedBytes: instanceState.options.maxQueuedBytes,
        workers: 0,
        ready: 0,
        active: 0,
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
    )
  }

  export async function stop(): Promise<void> {
    const instanceState = runtimeState()

    closeAdmission()
    if (instanceState.stopPromise) return instanceState.stopPromise
    const current = instanceState.pool
    instanceState.stopPromise = (async () => {
      await current?.stop()
      if (instanceState.pool === current) instanceState.pool = undefined
    })()
    try {
      await instanceState.stopPromise
    } finally {
      instanceState.stopPromise = undefined
    }
  }
}

export type { PolicyClassificationContext, PolicyClassificationInput } from "./protocol"
export {
  DEFAULT_POLICY_WORKER_POOL_OPTIONS,
  PolicyWorkerPool,
  PolicyWorkerStartupTimeoutError,
  PolicyWorkerTimeoutError,
  type PolicyWorkerPoolOptions,
} from "./worker-pool"
