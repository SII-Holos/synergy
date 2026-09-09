const activeTimers = new Map<string, Timer>()

function timerKey(scopeID: string, loopID: string): string {
  return `blueprint_deadline:${scopeID}:${loopID}`
}

export function hasDeadlineTimer(scopeID: string, loopID: string): boolean {
  return activeTimers.has(timerKey(scopeID, loopID))
}

export function clearTimer(scopeID: string, loopID: string): void {
  const existing = activeTimers.get(timerKey(scopeID, loopID))
  if (existing) {
    clearTimeout(existing)
    activeTimers.delete(timerKey(scopeID, loopID))
  }
}

export function setDeadlineTimer(scopeID: string, loopID: string, maxRuntimeMs: number, onExpire: () => void): void {
  clearTimer(scopeID, loopID)
  const timer = setTimeout(onExpire, maxRuntimeMs)
  timer.unref()
  activeTimers.set(timerKey(scopeID, loopID), timer)
}

export function cancelDeadline(scopeID: string, loopID: string): void {
  clearTimer(scopeID, loopID)
}
