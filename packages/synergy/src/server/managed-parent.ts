export interface ManagedParentWatcherOptions {
  expectedParentPid: string | undefined
  onParentExit: () => void
  getParentPid?: () => number
  intervalMs?: number
}

export function watchManagedParent(options: ManagedParentWatcherOptions): () => void {
  const expectedParentPid = Number(options.expectedParentPid)
  if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 1) return () => {}

  const getParentPid = options.getParentPid ?? (() => process.ppid)
  let active = true
  const timer = setInterval(() => {
    if (!active || getParentPid() === expectedParentPid) return
    active = false
    clearInterval(timer)
    options.onParentExit()
  }, options.intervalMs ?? 1_000)
  timer.unref()

  return () => {
    active = false
    clearInterval(timer)
  }
}
