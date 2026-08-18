import { MonotonicKeySpace } from "./monotonic-key-space"

export type SessionPartSnapshotRequest = {
  generation: number
  revisions: ReadonlyMap<string, number>
}

export type SessionPartSnapshotAction = "apply" | "preserve" | "retry"

function sessionKey(scopeKey: string, sessionID: string) {
  return `${scopeKey}\n${sessionID}`
}

function messageKey(scopeKey: string, sessionID: string, messageID: string) {
  return `${sessionKey(scopeKey, sessionID)}\n${messageID}`
}

export class SessionPartSnapshotFreshness {
  private readonly generations = new MonotonicKeySpace()
  private readonly revisions = new MonotonicKeySpace()
  private readonly snapshotRequiredRevisions = new MonotonicKeySpace()

  capture(scopeKey: string, sessionID: string): SessionPartSnapshotRequest {
    const generation = this.generation(scopeKey, sessionID)
    const prefix = `${sessionKey(scopeKey, sessionID)}\n`
    const revisions = new Map<string, number>()
    for (const [key, revision] of this.revisions.entries()) {
      if (key.startsWith(prefix)) revisions.set(key.slice(prefix.length), revision)
    }
    return { generation, revisions }
  }

  touch(scopeKey: string, sessionID: string, messageID: string, options?: { requiresSnapshot?: boolean }) {
    const key = messageKey(scopeKey, sessionID, messageID)
    const revision = this.revisions.allocate(key)
    if (options?.requiresSnapshot) this.snapshotRequiredRevisions.set(key, revision)
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
    if (this.snapshotRequiredRevisions.get(key) > capturedRevision) return "retry"
    return "preserve"
  }

  releaseScope(scopeKey: string) {
    const generationPrefix = `${scopeKey}\n`
    this.generations.deletePrefix(generationPrefix)
    const revisionPrefix = `${scopeKey}\n`
    this.revisions.deletePrefix(revisionPrefix)
    this.snapshotRequiredRevisions.deletePrefix(revisionPrefix)
  }

  releaseSession(scopeKey: string, sessionID: string) {
    this.generations.delete(sessionKey(scopeKey, sessionID))
    const prefix = `${sessionKey(scopeKey, sessionID)}\n`
    this.revisions.deletePrefix(prefix)
    this.snapshotRequiredRevisions.deletePrefix(prefix)
  }

  private generation(scopeKey: string, sessionID: string) {
    return this.generations.ensure(sessionKey(scopeKey, sessionID))
  }
}
