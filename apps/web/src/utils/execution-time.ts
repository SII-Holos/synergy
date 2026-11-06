export type ExecutionSample = { clockID: string; sampledAt: number; revision: number }

export function newerExecutionSample(current: ExecutionSample | undefined, next: ExecutionSample, snapshot = false) {
  if (!current) return true
  if (current.clockID !== next.clockID) return snapshot
  return next.revision > current.revision || (next.revision === current.revision && next.sampledAt >= current.sampledAt)
}

export class ExecutionClock {
  private receivedAt = 0
  private frozen = 0
  private active = false
  accept(now: number, active = true) {
    this.receivedAt = now
    this.frozen = 0
    this.active = active
  }
  pause(now: number) {
    this.frozen = this.advance(now)
    this.active = false
  }
  advance(now: number) {
    return this.active ? Math.max(0, now - this.receivedAt) : this.frozen
  }
}
