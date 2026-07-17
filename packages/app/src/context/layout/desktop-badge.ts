export type DesktopBadgeState = { count: number }
export type DesktopBadgeSetter = (state: DesktopBadgeState) => Promise<void>

export function createDesktopBadgeSync(setState?: DesktopBadgeSetter) {
  let confirmedCount: number | undefined
  let desiredCount: number | undefined
  let pendingCount: number | undefined
  let running: Promise<void> | undefined

  const flush = async () => {
    while (desiredCount !== undefined && desiredCount !== confirmedCount) {
      const nextCount = desiredCount
      pendingCount = nextCount
      try {
        await setState?.({ count: nextCount })
      } catch {
        pendingCount = undefined
        return
      }
      pendingCount = undefined
      confirmedCount = nextCount
    }
  }

  return (count: number | undefined): Promise<void> => {
    if (count === undefined || !setState) return Promise.resolve()
    if (count === confirmedCount && !running) return Promise.resolve()
    const previousDesiredCount = desiredCount
    desiredCount = count
    if (running) {
      if (count === pendingCount && previousDesiredCount === count) return Promise.resolve()
      return running
    }
    running = flush().finally(() => {
      running = undefined
    })
    return running
  }
}
