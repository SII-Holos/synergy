/**
 * Session-scoped no-op loop guard.
 * Hard-blocks the 3rd consecutive byte-identical no-op revise_file patch
 * for a given path within a session.
 */

export class NoopLoopGuard {
  static #sessions = new Map<string, Map<string, Map<string, number>>>()

  /**
   * Record a no-op patch attempt.
   * Returns the attempt count and whether escalation (a hard block) is triggered.
   */
  static record(sessionID: string, path: string, inputHash: string): { count: number; escalate: boolean } {
    let session = this.#sessions.get(sessionID)
    if (!session) {
      session = new Map()
      this.#sessions.set(sessionID, session)
    }
    let pathCounters = session.get(path)
    if (!pathCounters) {
      pathCounters = new Map()
      session.set(path, pathCounters)
    }
    const count = (pathCounters.get(inputHash) ?? 0) + 1
    pathCounters.set(inputHash, count)
    return { count, escalate: count >= 3 }
  }

  /** Reset all counters for a path after a successful edit. */
  static reset(sessionID: string, path: string): void {
    const session = this.#sessions.get(sessionID)
    if (session) session.delete(path)
  }

  /** Clear counters for one session, or all sessions when `sessionID` is omitted. */
  static clear(sessionID?: string): void {
    if (sessionID) {
      this.#sessions.delete(sessionID)
    } else {
      this.#sessions.clear()
    }
  }
}

/**
 * Diagnostic message for a no-op loop escalation.
 * Must match oh-my-pi style exactly.
 */
export function noopLoopDiagnostic(path: string, count: number): string {
  return `STOP. This exact revise_file patch has produced a byte-identical no-op 3 times in a row for ${path}. Do not re-issue this payload. Do not widen the SWAP range. Either the intended change is already present, or your anchor is wrong. Run view_file on the current file and produce a different patch from the fresh tag.`
}
