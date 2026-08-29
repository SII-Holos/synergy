/**
 * S9c source inversion: the L1 session domain observes agenda wake-ups
 * (upcoming reminder rendering, continuation blockers) through this registry
 * instead of importing the agenda product domain. The L4 product manifest
 * registers the implementation; unregistered access degrades quietly (no
 * reminder block, no blockers).
 */
export namespace SessionAgendaSignals {
  /** Scope agenda items projected for reminder rendering. The still-future
   * comparison stays with the caller so the reminder's elapsed-time
   * rendering and its filter share one clock reading. */
  export interface UpcomingWakeup {
    id: string
    title: string
    status: string
    wake: boolean
    originSessionID: string
    nextRunAt?: number
  }

  export interface SessionBlocker {
    id: string
    description: string
  }

  export interface Provider {
    upcomingWakeups(scopeID: string, sessionID: string): Promise<UpcomingWakeup[]>
    /** Wake-up blockers pinning the session's continuation. */
    sessionBlockers(sessionID: string, scopeID: string): Promise<SessionBlocker[]>
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  export function upcomingWakeups(scopeID: string, sessionID: string): Promise<UpcomingWakeup[]> {
    return provider?.upcomingWakeups(scopeID, sessionID) ?? Promise.resolve([])
  }

  export function sessionBlockers(sessionID: string, scopeID: string): Promise<SessionBlocker[]> {
    return provider?.sessionBlockers(sessionID, scopeID) ?? Promise.resolve([])
  }
}
