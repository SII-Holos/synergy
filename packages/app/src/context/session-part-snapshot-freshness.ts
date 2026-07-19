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
  private readonly generations = new Map<string, number>()
  private readonly revisions = new Map<string, number>()
  private readonly snapshotRequiredRevisions = new Map<string, number>()
  private nextGeneration = 1
  private nextRevision = 1

  capture(scopeKey: string, sessionID: string): SessionPartSnapshotRequest {
    const generation = this.generation(scopeKey, sessionID)
    const prefix = `${sessionKey(scopeKey, sessionID)}\n`
    const revisions = new Map<string, number>()
    for (const [key, revision] of this.revisions) {
      if (key.startsWith(prefix)) revisions.set(key.slice(prefix.length), revision)
    }
    return { generation, revisions }
  }

  touch(scopeKey: string, sessionID: string, messageID: string, options?: { requiresSnapshot?: boolean }) {
    const key = messageKey(scopeKey, sessionID, messageID)
    const revision = this.nextRevision++
    this.revisions.set(key, revision)
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
    if ((this.revisions.get(key) ?? 0) === capturedRevision) return "apply"
    if ((this.snapshotRequiredRevisions.get(key) ?? 0) > capturedRevision) return "retry"
    return "preserve"
  }

  releaseScope(scopeKey: string) {
    const generationPrefix = `${scopeKey}\n`
    for (const key of this.generations.keys()) {
      if (key.startsWith(generationPrefix)) this.generations.delete(key)
    }
    const revisionPrefix = `${scopeKey}\n`
    for (const key of this.revisions.keys()) {
      if (key.startsWith(revisionPrefix)) this.revisions.delete(key)
    }
    for (const key of this.snapshotRequiredRevisions.keys()) {
      if (key.startsWith(revisionPrefix)) this.snapshotRequiredRevisions.delete(key)
    }
  }

  releaseSession(scopeKey: string, sessionID: string) {
    this.generations.delete(sessionKey(scopeKey, sessionID))
    const prefix = `${sessionKey(scopeKey, sessionID)}\n`
    for (const key of this.revisions.keys()) {
      if (key.startsWith(prefix)) this.revisions.delete(key)
    }
    for (const key of this.snapshotRequiredRevisions.keys()) {
      if (key.startsWith(prefix)) this.snapshotRequiredRevisions.delete(key)
    }
  }

  private generation(scopeKey: string, sessionID: string) {
    const key = sessionKey(scopeKey, sessionID)
    const existing = this.generations.get(key)
    if (existing !== undefined) return existing
    const created = this.nextGeneration++
    this.generations.set(key, created)
    return created
  }
}
