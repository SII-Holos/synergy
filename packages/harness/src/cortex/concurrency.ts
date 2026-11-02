import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"

export namespace CortexConcurrency {
  interface Waiter {
    owner: string
    resolve(): void
    reject(error: unknown): void
    detach(): void
  }
  const state = RuntimeContext.state(() => ({
    running: new Map<string, number>(),
    queue: [] as Waiter[],
    configured: undefined as number | undefined,
    served: new Map<string, number>(),
    sequence: 0,
  }))

  export const GlobalStatus = z
    .object({
      configured: z.number().int().positive().nullable(),
      environment: z.number().int().positive().nullable(),
      effective: z.number().int().positive().describe("Configured global task ceiling"),
      source: z.enum(["default", "config", "environment"]),
      running: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
    })
    .meta({ ref: "CortexConcurrencyStatus" })
  export type GlobalStatus = z.infer<typeof GlobalStatus>

  export function configure(limit: number | undefined) {
    state().configured = positive(limit)
    drain()
  }

  function environment() {
    return positive(Number(RuntimeContext.current().host.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY))
  }
  function positive(value: number | undefined) {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
  }
  export function desiredGlobalLimit() {
    return environment() ?? state().configured ?? 8
  }
  export function getGlobalLimit() {
    return desiredGlobalLimit()
  }
  function running() {
    return [...state().running.values()].reduce((sum, count) => sum + count, 0)
  }

  export function acquire(owner: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const current = state()
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = current.queue.indexOf(waiter)
        if (index < 0) return
        current.queue.splice(index, 1)
        waiter.detach()
        reject(signal?.reason)
        drain()
      }
      const waiter = { owner, resolve, reject, detach: () => signal?.removeEventListener("abort", abort) }
      signal?.addEventListener("abort", abort, { once: true })
      current.queue.push(waiter)
      drain()
    })
  }

  export function release(owner: string) {
    const current = state()
    current.running.set(owner, Math.max(0, (current.running.get(owner) ?? 0) - 1))
    drain()
  }

  function drain() {
    const current = state()
    while (current.queue.length && running() < desiredGlobalLimit()) {
      const owners = [...new Set(current.queue.map((waiter) => waiter.owner))]
      const owner = owners.sort((a, b) => (current.served.get(a) ?? 0) - (current.served.get(b) ?? 0))[0]!
      const index = current.queue.findIndex((waiter) => waiter.owner === owner)
      const waiter = current.queue.splice(index, 1)[0]!
      waiter.detach()
      current.running.set(owner, (current.running.get(owner) ?? 0) + 1)
      current.served.set(owner, ++current.sequence)
      waiter.resolve()
    }
  }

  export function status(): Record<string, { running: number; queued: number }> {
    const current = state()
    const owners = new Set([...current.running.keys(), ...current.queue.map((waiter) => waiter.owner)])
    return Object.fromEntries(
      [...owners].map((owner) => [
        owner,
        {
          running: current.running.get(owner) ?? 0,
          queued: current.queue.filter((waiter) => waiter.owner === owner).length,
        },
      ]),
    )
  }

  export function globalStatus(): GlobalStatus {
    const current = state()
    const override = environment()
    return {
      configured: current.configured ?? null,
      environment: override ?? null,
      effective: desiredGlobalLimit(),
      source: override !== undefined ? "environment" : current.configured !== undefined ? "config" : "default",
      running: running(),
      queued: current.queue.length,
    }
  }

  export function reset() {
    const current = state()
    for (const waiter of current.queue.splice(0)) {
      waiter.detach()
      waiter.reject(new Error("Cortex concurrency reset"))
    }
    current.running.clear()
    current.configured = undefined
    current.served.clear()
    current.sequence = 0
  }
}
