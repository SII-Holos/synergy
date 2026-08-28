export interface ManagedParentWatcherOptions {
  expectedParentPid: string | undefined
  onParentExit: () => void
  hasProcess?: (pid: number) => boolean
  intervalMs?: number
}

function hasProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    )
  }
}

export function watchManagedParent(options: ManagedParentWatcherOptions): () => void {
  const expectedParentPid = Number(options.expectedParentPid)
  if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 1) return () => {}

  const isAlive = options.hasProcess ?? hasProcess
  let active = true
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    active = false
    if (timer) clearInterval(timer)
  }
  const check = () => {
    if (!active || isAlive(expectedParentPid)) return
    stop()
    options.onParentExit()
  }

  check()
  if (!active) return stop
  timer = setInterval(check, options.intervalMs ?? 1_000)
  timer.unref()
  return stop
}
