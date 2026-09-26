import { RuntimeContext } from "../lifecycle/context"
const runtimeState = RuntimeContext.state(() => ({
  monotonicCounter: 0,
}))
const processStartMs = Date.now()

export namespace ObservabilityClock {
  export function now() {
    return Date.now()
  }

  export function iso(time = now()) {
    return new Date(time).toISOString()
  }

  export function id(prefix: string) {
    const instanceState = runtimeState()

    return `${prefix}_${processStartMs.toString(36)}_${(instanceState.monotonicCounter++).toString(36)}`
  }

  export function start() {
    return performance.now()
  }

  export function durationMs(start: number) {
    return Math.max(0, performance.now() - start)
  }
}
