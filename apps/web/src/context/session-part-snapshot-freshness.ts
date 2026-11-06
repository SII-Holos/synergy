import { MonotonicKeySpace } from "./monotonic-key-space"

export type SessionPartSnapshotRequest = {
  generation: number
  revisions: ReadonlyMap<string, number>
}

export type SessionPartSnapshotAction = "apply" | "preserve" | "retry"

type SnapshotRequiredMark = {
  revision: number
  captureSeq: number
}

function sessionKey(scopeKey: string, sessionID: string) {
  return `${scopeKey}\n${sessionID}`
}

function messageKey(scopeKey: string, sessionID: string, messageID: string) {
  return `${sessionKey(scopeKey, sessionID)}\n${messageID}`
}

export class SessionPartSnapshotFreshness {
  private readonly generations = new MonotonicKeySpace()
  private readonly revisions = new MonotonicKeySpace()
  private readonly snapshotRequiredMarks = new Map<string, SnapshotRequiredMark>()
  private readonly captures = new MonotonicKeySpace()

  capture(scopeKey: string, sessionID: string): SessionPartSnapshotRequest {
    const session = sessionKey(scopeKey, sessionID)
    this.captures.allocate(session)
    const prefix = `${session}\n`
    const revisions = new Map<string, number>()
    for (const [key, revision] of this.revisions.entries()) {
      if (key.startsWith(prefix)) revisions.set(key.slice(prefix.length), revision)
    }
    return { generation: this.generation(scopeKey, sessionID), revisions }
  }

  touch(scopeKey: string, sessionID: string, messageID: string, options?: { requiresSnapshot?: boolean }) {
    const key = messageKey(scopeKey, sessionID, messageID)
    if (!options?.requiresSnapshot) {
      this.revisions.allocate(key)
      return
    }
    // Back-to-back authoritative checkpoints for one message with no capture
    // in between coalesce into a single mark: every in-flight request predates
    // the original mark and already retries, so extra revisions only widened
    // the superseded window during streaming bursts. A capture in between
    // re-arms the mark so that request still sees the newer checkpoint.
    const session = sessionKey(scopeKey, sessionID)
    const captureSeq = this.captures.get(session)
    const existing = this.snapshotRequiredMarks.get(key)
    if (existing && existing.captureSeq === captureSeq) return
    const revision = this.revisions.allocate(key)
    this.snapshotRequiredMarks.set(key, { revision, captureSeq })
  }

  action(
    scopeKey: string,
    sessionID: string,
    messageID: string,
    request: SessionPartSnapshotRequest,
  ): SessionPartSnapshotAction {
    if (this.generation(scopeKey, sessionID) !== request.generation) return "retry"
    const key = messageKey(scopeKey, sessionID, messageID)
    const capturedRevision = request.revisions.get(messageID) ?? 0
    if (this.revisions.get(key) === capturedRevision) return "apply"
    const mark = this.snapshotRequiredMarks.get(key)
    if (mark && mark.revision > capturedRevision) return "retry"
    return "preserve"
  }

  releaseScope(scopeKey: string) {
    const prefix = `${scopeKey}\n`
    this.generations.deletePrefix(prefix)
    this.revisions.deletePrefix(prefix)
    this.deleteMarksWithPrefix(prefix)
    this.captures.deletePrefix(prefix)
  }

  releaseSession(scopeKey: string, sessionID: string) {
    const session = sessionKey(scopeKey, sessionID)
    this.generations.delete(session)
    const prefix = `${session}\n`
    this.revisions.deletePrefix(prefix)
    this.deleteMarksWithPrefix(prefix)
    this.captures.delete(session)
  }

  private deleteMarksWithPrefix(prefix: string) {
    for (const key of this.snapshotRequiredMarks.keys()) {
      if (key.startsWith(prefix)) this.snapshotRequiredMarks.delete(key)
    }
  }

  private generation(scopeKey: string, sessionID: string) {
    return this.generations.ensure(sessionKey(scopeKey, sessionID))
  }
}
