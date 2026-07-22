import { ObservabilityMetrics } from "@/observability/metrics"

export namespace RetentionProbe {
  const CHECKPOINTS_MS = [30_000, 120_000] as const
  const MAX_GROUPS = 256
  const MAX_TARGETS_PER_GROUP = 32

  interface FinalizedTarget {
    groupID: string
    targetID: string
    owner: string
    sessionID: string
    messageID: string
    releasedAt?: number
  }

  interface Target {
    id: string
    owner: string
    ref: WeakRef<object>
    estimatedBytes: number
    unregisterToken: object
    finalized: FinalizedTarget
  }

  interface GroupState {
    id: string
    sessionID: string
    messageID: string
    createdAt: number
    releasedAt?: number
    checkpoint: number
    targets: Map<string, Target>
  }

  export interface Handle {
    track(owner: string, value: unknown, estimatedBytes?: number): void
    release(): void
  }

  const groups = new Map<string, GroupState>()
  let markers = new WeakMap<object, string>()
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const finalized = new FinalizationRegistry<FinalizedTarget>((held) => {
    const group = groups.get(held.groupID)
    const target = group?.targets.get(held.targetID)
    if (group && target) {
      group.targets.delete(held.targetID)
      if (held.releasedAt !== undefined) recordCollected(group, target, Date.now() - held.releasedAt)
      if (group.releasedAt !== undefined && group.targets.size === 0) groups.delete(group.id)
      return
    }
    if (held.releasedAt !== undefined) recordCollectedHeld(held, Date.now() - held.releasedAt)
  })

  export function begin(input: { sessionID: string; messageID: string; env?: NodeJS.ProcessEnv }): Handle {
    if (!enabled(input.env)) return disabledHandle
    pruneGroups()
    const id = `${input.sessionID}:${input.messageID}:${++sequence}`
    const group: GroupState = {
      id,
      sessionID: input.sessionID,
      messageID: input.messageID,
      createdAt: Date.now(),
      checkpoint: 0,
      targets: new Map(),
    }
    groups.set(id, group)
    let released = false
    return {
      track(owner, value, estimatedBytes = 0) {
        if (released || (typeof value !== "object" && typeof value !== "function") || value === null) return
        if (group.targets.size >= MAX_TARGETS_PER_GROUP) return
        const target = value as object
        const targetID = `${id}:${owner}:${group.targets.size + 1}`
        markers.set(target, targetID)
        const unregisterToken = {}
        const held: FinalizedTarget = {
          groupID: id,
          targetID,
          owner,
          sessionID: group.sessionID,
          messageID: group.messageID,
        }
        const record: Target = {
          id: targetID,
          owner,
          ref: new WeakRef(target),
          estimatedBytes: finite(estimatedBytes),
          unregisterToken,
          finalized: held,
        }
        group.targets.set(targetID, record)
        finalized.register(target, held, unregisterToken)
      },
      release() {
        if (released) return
        released = true
        group.releasedAt = Date.now()
        for (const target of group.targets.values()) target.finalized.releasedAt = group.releasedAt
        for (const target of group.targets.values()) {
          ObservabilityMetrics.record({
            name: "llm.turn.retention.target_bytes",
            value: target.estimatedBytes,
            unit: "bytes",
            module: "llm",
            sessionID: group.sessionID,
            messageID: group.messageID,
            labels: { owner: target.owner },
          })
        }
        if (group.targets.size === 0) groups.delete(group.id)
        else scheduleSweep()
      },
    }
  }

  export function checkReleased(input: { phase: string; afterGC: boolean; now?: number }) {
    const now = input.now ?? Date.now()
    for (const group of groups.values()) {
      if (group.releasedAt === undefined) continue
      checkGroup(group, input.phase, input.afterGC, now)
    }
  }

  export function stats() {
    let targets = 0
    let releasedGroups = 0
    for (const group of groups.values()) {
      targets += group.targets.size
      if (group.releasedAt !== undefined) releasedGroups++
    }
    return { groups: groups.size, releasedGroups, targets }
  }

  export function resetForTest() {
    if (timer) clearTimeout(timer)
    timer = undefined
    for (const group of groups.values()) unregisterGroup(group)
    groups.clear()
    markers = new WeakMap<object, string>()
    sequence = 0
  }

  export function markerForTest(value: object) {
    return markers.get(value)
  }

  function checkGroup(group: GroupState, phase: string, afterGC: boolean, now: number) {
    const ageMs = Math.max(0, now - (group.releasedAt ?? now))
    for (const [id, target] of group.targets) {
      const alive = target.ref.deref() !== undefined
      ObservabilityMetrics.record({
        name: "llm.turn.retention.alive",
        value: alive ? 1 : 0,
        unit: "count",
        module: "llm",
        sessionID: group.sessionID,
        messageID: group.messageID,
        labels: { owner: target.owner, phase, afterGC },
      })
      ObservabilityMetrics.record({
        name: "llm.turn.retention.age",
        value: ageMs,
        unit: "ms",
        module: "llm",
        sessionID: group.sessionID,
        messageID: group.messageID,
        labels: { owner: target.owner, phase, alive, afterGC },
      })
      if (!alive) {
        finalized.unregister(target.unregisterToken)
        recordCollected(group, target, ageMs)
        group.targets.delete(id)
      }
    }
    if (group.targets.size === 0) groups.delete(group.id)
  }

  function scheduleSweep() {
    if (timer) return
    const next = [...groups.values()]
      .filter((group) => group.releasedAt !== undefined && group.checkpoint < CHECKPOINTS_MS.length)
      .reduce(
        (minimum, group) => Math.min(minimum, group.releasedAt! + CHECKPOINTS_MS[group.checkpoint] - Date.now()),
        Number.POSITIVE_INFINITY,
      )
    if (!Number.isFinite(next)) return
    timer = setTimeout(sweep, Math.max(1, next))
    timer.unref()
  }

  function sweep() {
    timer = undefined
    const now = Date.now()
    for (const group of groups.values()) {
      if (group.releasedAt === undefined || group.checkpoint >= CHECKPOINTS_MS.length) continue
      const dueAt = group.releasedAt + CHECKPOINTS_MS[group.checkpoint]
      if (now < dueAt) continue
      checkGroup(group, `release.${CHECKPOINTS_MS[group.checkpoint] / 1000}s`, false, now)
      group.checkpoint++
      if (group.checkpoint >= CHECKPOINTS_MS.length) dropGroup(group)
    }
    scheduleSweep()
  }

  function pruneGroups() {
    if (groups.size < MAX_GROUPS) return
    const remove = [...groups.values()]
      .sort((a, b) => (a.releasedAt ?? a.createdAt) - (b.releasedAt ?? b.createdAt))
      .slice(0, groups.size - MAX_GROUPS + 1)
    for (const group of remove) dropGroup(group)
  }

  function recordCollected(group: GroupState, target: Target, durationMs: number) {
    ObservabilityMetrics.record({
      name: "llm.turn.retention.collected",
      value: Math.max(0, durationMs),
      unit: "ms",
      module: "llm",
      sessionID: group.sessionID,
      messageID: group.messageID,
      labels: { owner: target.owner },
    })
  }

  function recordCollectedHeld(target: FinalizedTarget, durationMs: number) {
    ObservabilityMetrics.record({
      name: "llm.turn.retention.collected",
      value: Math.max(0, durationMs),
      unit: "ms",
      module: "llm",
      sessionID: target.sessionID,
      messageID: target.messageID,
      labels: { owner: target.owner },
    })
  }

  function unregisterGroup(group: GroupState) {
    for (const target of group.targets.values()) finalized.unregister(target.unregisterToken)
  }

  function dropGroup(group: GroupState) {
    unregisterGroup(group)
    groups.delete(group.id)
  }

  function enabled(env: NodeJS.ProcessEnv = process.env) {
    const value = env.SYNERGY_RETENTION_PROBE_ENABLED
    if (value === undefined) return true
    const normalized = value.trim().toLowerCase()
    return normalized !== "" && normalized !== "0" && normalized !== "false"
  }

  function finite(value: number) {
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  const disabledHandle: Handle = {
    track() {},
    release() {},
  }
}
