import { RuntimeContext } from "../../lifecycle/context"
import { Context } from "../../util/context"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutSchema } from "./schema"

export namespace RolloutExecution {
  type Identity = { owner: RolloutSchema.Owner; runID: string; signal?: AbortSignal }
  type Branch = Identity & {
    id: string
    segment?: RolloutSchema.ExecutionSegment
    interval?: RolloutSchema.ExecutionInterval
    suspended: number
    closed: boolean
  }
  const context = Context.create<Branch>("rollout.execution")
  const state = RuntimeContext.state(() => ({ clockID: crypto.randomUUID(), branches: new Set<Branch>() }))

  export function clock() {
    return { clockID: state().clockID, now: performance.now() }
  }

  export function measure(
    intervals: RolloutSchema.ExecutionInterval[],
    sample: { clockID: string; now: number } = clock(),
  ) {
    const groups = new Map<string, Array<readonly [number, number]>>()
    let elapsedActive = false
    let elapsedLowerBound = false
    let waiting = false
    for (const interval of intervals) {
      const current = interval.clockID === sample.clockID
      const active = interval.status === "active" && current
      elapsedActive ||= active
      waiting ||= interval.status === "waiting" && current
      elapsedLowerBound ||= interval.coverage === "partial" || (interval.ended == null && !active)
      const ended = interval.ended ?? (active ? sample.now : interval.started)
      const group = groups.get(interval.clockID) ?? []
      group.push([interval.started, Math.max(interval.started, ended)])
      groups.set(interval.clockID, group)
    }
    let elapsedMs = 0
    for (const intervals of groups.values()) {
      let end = -Infinity
      for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
        elapsedMs += Math.max(0, stop - Math.max(start, end))
        end = Math.max(end, stop)
      }
    }
    return { elapsedMs, elapsedActive, elapsedLowerBound, waiting }
  }

  export function summarize(
    input: {
      roots: RolloutSchema.RunRecord[]
      runs: RolloutSchema.RunRecord[]
      intervals: RolloutSchema.ExecutionInterval[]
      segments?: RolloutSchema.ExecutionSegment[]
      hasHistory?: boolean
      paused?: boolean
      queued?: boolean
    },
    sample?: { clockID: string; now: number },
  ) {
    const measured = measure(input.intervals, sample)
    const actual = input.runs.filter((run) => !run.admissionOnly)
    const history = input.hasHistory || actual.length > 0 || input.intervals.length > 0
    const missing = actual.some((run) => {
      const owner = JSON.stringify(run.owner)
      const intervals = input.intervals.filter(
        (interval) => interval.runID === run.id && JSON.stringify(interval.owner) === owner,
      )
      return (
        !intervals.length ||
        input.segments?.some(
          (segment) =>
            segment.runID === run.id &&
            JSON.stringify(segment.owner) === owner &&
            !intervals.some((interval) => interval.segmentID === segment.id),
        )
      )
    })
    const latest = input.roots
      .filter((run) => !run.admissionOnly)
      .toSorted((a, b) => b.started - a.started || b.id.localeCompare(a.id))[0]
    const outcome = latest?.execution?.status ?? latest?.status
    const status = measured.elapsedActive
      ? "running"
      : measured.waiting
        ? "waiting"
        : input.paused
          ? "paused"
          : input.queued
            ? "queued"
            : outcome && outcome !== "running"
              ? outcome
              : "unknown"
    return {
      status,
      elapsedMs: history ? measured.elapsedMs : null,
      elapsedActive: measured.elapsedActive,
      elapsedLowerBound: Boolean(history && (measured.elapsedLowerBound || missing || !input.intervals.length)),
    }
  }

  export async function write(interval: RolloutSchema.ExecutionInterval) {
    await RolloutJournal.write(
      interval.owner,
      [...RolloutArtifact.root(interval.owner), "runs", interval.runID, "intervals", interval.id],
      interval,
    )
  }

  async function open(branch: Branch) {
    if (!branch.segment || branch.closed || branch.suspended || branch.signal?.aborted) return
    const sample = clock()
    const interval: RolloutSchema.ExecutionInterval = {
      version: 1,
      id: crypto.randomUUID(),
      owner: branch.owner,
      runID: branch.runID,
      segmentID: branch.segment.id,
      branchID: branch.id,
      clockID: sample.clockID,
      started: sample.now,
      status: "active",
      coverage: "complete",
    }
    branch.interval = interval
    await write(interval)
  }

  async function close(branch: Branch, waiting = false) {
    const interval = branch.interval
    if (!interval) return
    if (interval.ended == null) interval.ended = Math.max(interval.started, performance.now())
    interval.status = waiting ? "waiting" : "closed"
    await write(interval)
  }

  export function provide<T>(identity: Identity, action: () => T): T {
    return context.provide({ ...identity, id: "main", suspended: 0, closed: false }, action)
  }

  export async function start(segment: RolloutSchema.ExecutionSegment) {
    const branch = context.tryUse()
    if (!branch || branch.closed || branch.runID !== segment.runID) return
    branch.segment = segment
    state().branches.add(branch)
    await open(branch)
  }

  export async function stop(segment: RolloutSchema.ExecutionSegment) {
    for (const branch of state().branches) {
      if (branch.segment?.id !== segment.id) continue
      branch.closed = true
      await close(branch)
      state().branches.delete(branch)
    }
  }

  export async function suspend<T>(action: () => Promise<T>, human = false): Promise<T> {
    const branch = context.tryUse()
    if (!branch?.segment || branch.closed) return action()
    branch.suspended++
    if (branch.suspended === 1) await close(branch, human)
    try {
      return await action()
    } finally {
      branch.suspended--
      if (!branch.suspended && !branch.closed) {
        await close(branch)
        await open(branch)
      }
    }
  }

  export function wait<T>(action: () => Promise<T>) {
    return suspend(action, true)
  }

  export async function branch<T>(id: string, action: () => Promise<T>): Promise<T> {
    const parent = context.tryUse()
    if (!parent?.segment || parent.closed) return action()
    const branch: Branch = {
      owner: parent.owner,
      runID: parent.runID,
      signal: parent.signal,
      segment: parent.segment,
      id,
      suspended: 0,
      closed: false,
    }
    state().branches.add(branch)
    return context.provide(branch, async () => {
      await open(branch)
      try {
        return await action()
      } finally {
        branch.closed = true
        await close(branch)
        state().branches.delete(branch)
      }
    })
  }

  export async function recover(interval: RolloutSchema.ExecutionInterval) {
    if (interval.status !== "active" && interval.status !== "waiting") return
    for (const branch of state().branches) {
      if (branch.interval?.id !== interval.id) continue
      branch.closed = true
      state().branches.delete(branch)
    }
    await write({
      ...interval,
      status: interval.status === "waiting" ? "closed" : "interrupted",
      coverage: interval.status === "active" ? "partial" : interval.coverage,
      detectedAt: Date.now(),
    })
  }
}
