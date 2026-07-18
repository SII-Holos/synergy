export type SyncResource = "dag" | "todo" | "inbox" | "message"

export type SyncVersion = {
  epoch: string
  seq: number
}

export type SyncResourceKey = {
  scopeKey: string
  sessionID: string
  resource: SyncResource
}

export type SyncResourceRequest = {
  generation: number
  revision: number
}

type ScopeVersion = SyncVersion

function resourceKey(input: SyncResourceKey) {
  return `${input.scopeKey}\n${input.sessionID}\n${input.resource}`
}

function isValidVersion(version: SyncVersion | undefined): version is SyncVersion {
  return !!version?.epoch && Number.isSafeInteger(version.seq) && version.seq >= 0
}

export function parseSyncVersion(input: { epoch?: unknown; seq?: unknown } | undefined): SyncVersion | undefined {
  const version = {
    epoch: typeof input?.epoch === "string" ? input.epoch : "",
    seq: typeof input?.seq === "number" ? input.seq : Number.NaN,
  }
  return isValidVersion(version) ? version : undefined
}

export function readSyncVersion(headers: Pick<Headers, "get"> | undefined): SyncVersion | undefined {
  const epoch = headers?.get("x-synergy-epoch")
  const rawSeq = headers?.get("x-synergy-seq")
  if (!epoch || rawSeq === null || rawSeq === undefined) return undefined
  return parseSyncVersion({ epoch, seq: Number(rawSeq) })
}

export class SyncResourceFreshness {
  private readonly resources = new Map<string, SyncVersion>()
  private readonly scopes = new Map<string, ScopeVersion>()
  private readonly retiredEpochs = new Map<string, Set<string>>()
  private readonly generations = new Map<string, number>()
  private nextGeneration = 1
  private readonly revisions = new Map<string, number>()
  private nextRevision = 1

  current(input: SyncResourceKey): SyncVersion | undefined {
    return this.resources.get(resourceKey(input))
  }

  capture(input: SyncResourceKey): SyncResourceRequest {
    return {
      generation: this.generation(input.scopeKey),
      revision: this.revisions.get(resourceKey(input)) ?? 0,
    }
  }

  unchanged(input: SyncResourceKey, request: SyncResourceRequest): boolean {
    return (
      this.generation(input.scopeKey) === request.generation &&
      (this.revisions.get(resourceKey(input)) ?? 0) === request.revision
    )
  }
  invalidate(input: SyncResourceKey) {
    this.resources.delete(resourceKey(input))
    this.bumpRevision(input)
  }

  acceptResponse(input: SyncResourceKey, request: SyncResourceRequest, version: SyncVersion | undefined): boolean {
    if (this.generation(input.scopeKey) !== request.generation) return false
    if ((this.revisions.get(resourceKey(input)) ?? 0) !== request.revision) {
      if (!isValidVersion(version) || !this.current(input)) return false
    }
    return this.acceptSnapshot(input, version)
  }

  acceptScopeEvent(scopeKey: string, version: SyncVersion | undefined): boolean {
    if (!isValidVersion(version)) return true
    if (this.retiredEpochs.get(scopeKey)?.has(version.epoch)) return false
    const current = this.scopes.get(scopeKey)
    if (!current) {
      this.scopes.set(scopeKey, { epoch: version.epoch, seq: 0 })
      return true
    }
    if (current.epoch === version.epoch) return version.seq >= current.seq

    this.retireEpoch(scopeKey, current.epoch)
    this.advanceGeneration(scopeKey)
    this.clearResources(scopeKey)
    this.scopes.set(scopeKey, version)
    return true
  }

  acceptEvent(input: SyncResourceKey, version: SyncVersion | undefined): boolean {
    if (isValidVersion(version)) {
      if (!this.acceptScopeEvent(input.scopeKey, version)) return false
      const current = this.current(input)
      if (current?.epoch === version.epoch && version.seq <= current.seq) return false
      this.resources.set(resourceKey(input), version)
    } else this.resources.delete(resourceKey(input))
    this.bumpRevision(input)
    return true
  }

  acceptSnapshot(input: SyncResourceKey, version: SyncVersion | undefined): boolean {
    if (isValidVersion(version)) {
      if (!this.prepareSnapshotScope(input.scopeKey, version)) return false
      const current = this.current(input)
      if (current?.epoch === version.epoch && version.seq < current.seq) return false
      this.resources.set(resourceKey(input), version)
    } else this.resources.delete(resourceKey(input))
    this.bumpRevision(input)
    return true
  }

  resetScope(scopeKey: string, epoch: string, seq = 0): boolean {
    const next = { epoch, seq }
    if (!isValidVersion(next)) return false
    if (this.retiredEpochs.get(scopeKey)?.has(epoch)) return false
    const current = this.scopes.get(scopeKey)
    if (current?.epoch && current.epoch !== epoch) this.retireEpoch(scopeKey, current.epoch)
    this.advanceGeneration(scopeKey)
    this.clearResources(scopeKey)
    this.scopes.set(scopeKey, next)
    return true
  }

  releaseScope(scopeKey: string) {
    this.advanceGeneration(scopeKey)
    this.clearResources(scopeKey)
    this.scopes.delete(scopeKey)
    this.retiredEpochs.delete(scopeKey)
  }

  private prepareSnapshotScope(scopeKey: string, version: SyncVersion): boolean {
    if (this.retiredEpochs.get(scopeKey)?.has(version.epoch)) return false
    const current = this.scopes.get(scopeKey)
    if (!current) {
      this.scopes.set(scopeKey, { epoch: version.epoch, seq: 0 })
      return true
    }
    if (current.epoch !== version.epoch) return false
    return version.seq >= current.seq
  }

  private retireEpoch(scopeKey: string, epoch: string) {
    const retired = this.retiredEpochs.get(scopeKey) ?? new Set<string>()
    retired.add(epoch)
    this.retiredEpochs.set(scopeKey, retired)
  }

  private generation(scopeKey: string) {
    const existing = this.generations.get(scopeKey)
    if (existing !== undefined) return existing
    const created = this.nextGeneration++
    this.generations.set(scopeKey, created)
    return created
  }

  private advanceGeneration(scopeKey: string) {
    this.generations.set(scopeKey, this.nextGeneration++)
  }

  private bumpRevision(input: SyncResourceKey) {
    this.revisions.set(resourceKey(input), this.nextRevision++)
  }

  private clearResources(scopeKey: string) {
    const prefix = `${scopeKey}\n`
    for (const key of this.resources.keys()) {
      if (key.startsWith(prefix)) this.resources.delete(key)
    }
    for (const key of this.revisions.keys()) {
      if (key.startsWith(prefix)) this.revisions.delete(key)
    }
  }
}
