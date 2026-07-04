export namespace PerformanceClock {
  export function now() {
    return Date.now()
  }

  export function iso(time = now()) {
    return new Date(time).toISOString()
  }

  export function id(prefix: string) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  }

  export function start() {
    return performance.now()
  }

  export function durationMs(start: number) {
    return Math.max(0, performance.now() - start)
  }
}
