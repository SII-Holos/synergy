import type { GateOptions, ClassifyResult } from "../gate"
import type { PolicyClassificationContext } from "./protocol"
import { DEFAULT_POLICY_WORKER_POOL_OPTIONS, PolicyWorkerPool, type PolicyWorkerPoolOptions } from "./worker-pool"

export namespace PolicyWorker {
  let pool: PolicyWorkerPool | undefined
  let options = DEFAULT_POLICY_WORKER_POOL_OPTIONS
  let accepting = true
  let stopPromise: Promise<void> | undefined

  export function configure(input: Partial<PolicyWorkerPoolOptions> = {}): void {
    if (pool) throw new Error("Policy worker pool cannot be reconfigured after it has started")
    accepting = true
    options = {
      ...DEFAULT_POLICY_WORKER_POOL_OPTIONS,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    }
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

  export async function start(): Promise<void> {
    if (!accepting || stopPromise) throw new Error("Policy worker pool is stopping")
    pool ??= new PolicyWorkerPool(options)
    pool.start()
    await pool.ready()
  }

  export async function classify(input: {
    context: PolicyClassificationContext
    toolName: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<ClassifyResult> {
    if (!accepting || stopPromise) return Promise.reject(new Error("Policy worker pool is stopping"))
    pool ??= new PolicyWorkerPool(options)
    pool.start()
    await pool.ready(input.signal)
    return await pool.run(
      {
        context: input.context,
        toolName: input.toolName,
        args: input.args,
      },
      input.signal,
    )
  }

  export function stats() {
    return (
      pool?.stats() ?? {
        configured: options.size,
        maxQueued: options.maxQueued,
        maxQueuedBytes: options.maxQueuedBytes,
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
    if (stopPromise) return stopPromise
    accepting = false
    const current = pool
    stopPromise = (async () => {
      await current?.stop()
      if (pool === current) pool = undefined
    })()
    try {
      await stopPromise
    } finally {
      stopPromise = undefined
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
