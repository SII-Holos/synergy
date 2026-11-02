import { RuntimeContext } from "../lifecycle/context"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import { MemoryAdmission, type MemoryRequest } from "./admission"
import { ResourceHost } from "./host"
import { ResourceSnapshot, ResourceStatus } from "./schema"
import { ExecutionCapacity } from "../session/execution-capacity"

export namespace RuntimeResources {
  export const Event = BusEvent.define("runtime.resources", ResourceStatus, { streaming: true })
  const state = RuntimeContext.state(() => ({
    gate: new MemoryAdmission({ changed: () => changed() }),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    publishTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    sampling: undefined as Promise<void> | undefined,
    unobserve: undefined as (() => void) | undefined,
    started: false,
    stopping: false,
    listeners: new Set<(status: ResourceStatus) => void>(),
  }))

  export function status() {
    return state().gate.status()
  }
  export function setLimit(pool: string, limit: number) {
    state().gate.setLimit(pool, limit)
  }
  export function poolStatus(pool: string) {
    return state().gate.poolStatus(pool)
  }

  export async function reserve(request: MemoryRequest) {
    const lease = await ExecutionCapacity.wait(() => acquire(request))
    let released = false
    return {
      async release() {
        if (released) return
        released = true
        await sample()
        lease.release()
      },
    }
  }

  export async function allocation<T>(request: MemoryRequest, work: () => Promise<T>): Promise<T> {
    const lease = await ExecutionCapacity.wait(() => acquire(request))
    try {
      request.signal?.throwIfAborted()
      return await work()
    } finally {
      await sample()
      lease.release()
    }
  }

  export async function acquire(request: MemoryRequest) {
    const current = state()
    if (!current.started) await start()
    const result = current.gate.acquire(request)
    schedule()
    return result
  }

  export function subscribe(listener: (status: ResourceStatus) => void) {
    const listeners = state().listeners
    const bound = RuntimeContext.current().bind(listener)
    listeners.add(bound)
    return () => {
      listeners.delete(bound)
    }
  }

  export async function start() {
    const current = state()
    if (current.started) return current.sampling
    current.started = true
    current.unobserve = ResourceHost.get()?.observe?.(
      RuntimeContext.current().bind(() => {
        void sample()
      }),
    )
    await sample()
  }

  export function sample(): Promise<void> {
    const current = state()
    if (current.stopping) return Promise.resolve()
    if (current.sampling) return current.sampling
    current.sampling = (async () => {
      const source = ResourceHost.get()
      const snapshot = await source
        ?.sample()
        .then((value) => ResourceSnapshot.parse(value))
        .catch(() => undefined)
      if (current.stopping) return
      current.gate.update(
        snapshot ?? {
          sampledAt: Date.now(),
          quality: "unavailable",
          pressure: "normal",
          domains: [],
          processRssBytes: process.memoryUsage.rss(),
        },
      )
    })().finally(() => {
      current.sampling = undefined
      schedule()
    })
    return current.sampling
  }

  export function closeAdmission() {
    state().gate.close()
  }

  export async function stop() {
    const current = state()
    current.stopping = true
    current.gate.close()
    clearTimeout(current.timer)
    clearTimeout(current.publishTimer)
    current.unobserve?.()
    await current.sampling
    ResourceHost.get()?.close?.()
    current.listeners.clear()
  }

  function schedule() {
    const current = state()
    if (!current.started || current.stopping) return
    clearTimeout(current.timer)
    current.timer = setTimeout(
      RuntimeContext.current().bind(() => {
        void sample()
      }),
      current.gate.intervalMs(),
    )
    current.timer.unref()
  }

  function changed() {
    const current = state()
    if (current.stopping || current.publishTimer) return
    current.publishTimer = setTimeout(
      RuntimeContext.current().bind(() => {
        current.publishTimer = undefined
        const value = status()
        GlobalBus().emit("event", { scopeID: null, payload: { type: Event.type, properties: value } })
        for (const listener of current.listeners) listener(value)
      }),
      100,
    )
    current.publishTimer.unref()
  }
}
