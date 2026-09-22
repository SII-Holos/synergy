import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
const runtimeState = RuntimeContext.state(() => ({
  activeTimers: new Map<string, Timer>(),
}))

function timerKey(scopeID: string, loopID: string): string {
  return `blueprint_deadline:${scopeID}:${loopID}`
}

export function hasDeadlineTimer(scopeID: string, loopID: string): boolean {
  const instanceState = runtimeState()

  return instanceState.activeTimers.has(timerKey(scopeID, loopID))
}

export function clearTimer(scopeID: string, loopID: string): void {
  const instanceState = runtimeState()

  const existing = instanceState.activeTimers.get(timerKey(scopeID, loopID))
  if (existing) {
    clearTimeout(existing)
    instanceState.activeTimers.delete(timerKey(scopeID, loopID))
  }
}

export function setDeadlineTimer(scopeID: string, loopID: string, maxRuntimeMs: number, onExpire: () => void): void {
  const instanceState = runtimeState()

  clearTimer(scopeID, loopID)
  const timer = setTimeout(onExpire, maxRuntimeMs)
  timer.unref()
  instanceState.activeTimers.set(timerKey(scopeID, loopID), timer)
}

export function cancelDeadline(scopeID: string, loopID: string): void {
  clearTimer(scopeID, loopID)
}
