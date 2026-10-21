import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { SessionCorpus } from "@ericsanchezok/synergy-harness/session/corpus"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { original, sketch, normalize, representativePool, familyProjections, type Sketch } from "./evidence"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"

const version = 2
const Projection = z.object({
  version: z.literal(version),
  ready: z.boolean(),
  phase: z.enum(["index", "sketch"]),
  family: z.string(),
  fingerprints: z.array(z.string()),
  source: z.array(z.object({ key: z.array(z.string()), revision: z.string().nullable() })),
  indexCursor: z.object({ after: z.array(z.string()).optional(), current: z.array(z.string()).optional() }).optional(),
  messageCursor: z.array(z.string()).optional(),
  references: z.array(z.object({ reference: SessionCorpus.Reference, fingerprint: z.string(), created: z.number() })),
  statistics: z.object({
    count: z.number(),
    characters: z.number(),
    han: z.number(),
    latin: z.number(),
    questions: z.number(),
    commas: z.number(),
    newlines: z.number(),
    lengths: z.array(z.number()),
  }),
  legacyReads: z.number(),
})
type Projection = z.infer<typeof Projection>
const log = Log.create({ service: "digital-twin.preparation" })
const state = RuntimeContext.state(() => ({
  started: false,
  closed: false,
  controller: new AbortController(),
  task: undefined as Promise<void> | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  queue: new Map<string, { scopeID: string; sessionID: string }>(),
  unsubscribe: [] as Array<() => void>,
  projections: new Map<string, Projection>(),
  generations: new Map<string, number>(),
  loading: undefined as Promise<void> | undefined,
  reconcileAfterResume: undefined as boolean | undefined,
  selection: { references: [], statistics: [], generations: [] } as {
    references: SessionCorpus.Reference[]
    statistics: Sketch[]
    generations: Array<[string, number]>
  },
}))

function sourceKeys(owner: { scopeID: string; sessionID: string }) {
  return [
    StoragePath.sessionInfo(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID)),
    StoragePath.sessionMessageOrderState(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID)),
  ]
}
async function current(sources: Projection["source"]) {
  const revisions = await Storage.revisions(sources.map((source) => source.key))
  return sources.every((source, index) => source.revision === (revisions[index]?.toString() ?? null))
}

export function prepareStep(owner: { scopeID: string; sessionID: string }, signal?: AbortSignal) {
  return UpgradeWork.run({ background: true, sessionID: owner.sessionID, signal }, async () => {
    await UpgradeWork.checkpoint()
    return prepareBatch(owner, signal)
  })
}

async function prepareBatch(owner: { scopeID: string; sessionID: string }, signal?: AbortSignal) {
  const instance = state()
  const generation = instance.generations.get(owner.sessionID) ?? 0
  const key = StoragePath.digitalTwinSession(owner.scopeID, owner.sessionID)
  const source = await Storage.snapshot(async (tx) => {
    const [raw] = await tx.readMany([key])
    const parsed = Projection.safeParse(raw)
    const [revision] = await tx.revisions([key])
    const keys = sourceKeys(owner)
    const revisions = await tx.revisions(keys)
    if (revisions[0] === undefined) return undefined
    const previous = parsed.success && (await current(parsed.data.source)) ? parsed.data : undefined
    return {
      revision,
      value:
        previous ??
        ({
          version,
          ready: false,
          phase: "index" as const,
          family: owner.sessionID,
          fingerprints: [],
          source: keys.map((key, index) => ({ key, revision: revisions[index]?.toString() ?? null })),
          references: [],
          statistics: sketch([]),
          legacyReads: 0,
        } as Projection),
    }
  })
  if (!source || source.value.ready) return true
  const next = structuredClone(source.value)
  if (next.phase === "index") {
    const result = await SessionCorpus.prepare({ ...owner, cursor: next.indexCursor, signal })
    next.indexCursor = result.cursor
    next.legacyReads += result.legacyReads
    if (result.ready) next.phase = "sketch"
  } else {
    const page = await SessionCorpus.messages({ ...owner, cursor: next.messageCursor, limit: 16 })
    for (const message of page.items) {
      await UpgradeWork.checkpoint()
      next.source.push(...message.reference.sources)
      next.family = message.reference.family
      const text = original(message)
      if (!text || (await SecretMask.apply(text)) !== text) continue
      const fingerprint = InputAssistance.fingerprint(normalize(text))
      if (next.fingerprints.includes(fingerprint)) continue
      next.fingerprints.push(fingerprint)
      const value = sketch([text])
      for (const field of ["count", "characters", "han", "latin", "questions", "commas", "newlines"] as const)
        next.statistics[field] += value[field]
      next.statistics.lengths = next.statistics.lengths.map((count, index) => count + value.lengths[index]!)
      if (!next.references.some((entry) => entry.fingerprint === fingerprint))
        next.references.push({ reference: message.reference, fingerprint, created: message.info.time.created })
      next.references = representativePool(
        next.references.map((entry) => ({ ...entry, family: next.family })),
        24,
        12,
      )
    }
    next.source = [...new Map(next.source.toReversed().map((source) => [JSON.stringify(source.key), source])).values()]
    next.messageCursor = page.cursor
    next.ready = !page.cursor
  }
  signal?.throwIfAborted()
  const ready = await Storage.transaction(async (tx) => {
    if ((await tx.revisions([key]))[0] !== source.revision || !(await current(next.source))) return false
    await tx.write(key, next)
    return next.ready
  })
  if (ready && generation === (instance.generations.get(owner.sessionID) ?? 0)) {
    instance.projections.set(owner.sessionID, next)
    publishSelection()
  }
  return ready
}

async function run() {
  const instance = state()
  const signal = instance.controller.signal
  await UpgradeWork.checkpoint()
  while (!signal.aborted) {
    const queued = instance.queue.entries().next().value
    if (!queued) break
    const [id, owner] = queued
    const work = UpgradeWork.controller(true, owner.sessionID)
    try {
      if (
        (await prepareStep(owner, AbortSignal.any([signal, work.controller.signal]))) &&
        instance.queue.get(id) === owner
      )
        instance.queue.delete(id)
    } finally {
      work.dispose()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  if (signal.aborted) return
  publishSelection()
  type Cursor = {
    version: number
    after?: string[]
    pending?: Array<{ scopeID: string; sessionID: string }>
    complete?: boolean
  }
  const [stored] = await Storage.readMany<Cursor>([StoragePath.digitalTwinCursor()])
  const cursor = stored?.version === version ? stored : undefined
  instance.reconcileAfterResume ??= Boolean(cursor?.after || cursor?.complete || cursor?.pending?.length)
  if (cursor?.pending?.length) {
    const owner = cursor.pending[0]!
    const work = UpgradeWork.controller(true, owner.sessionID)
    try {
      if (await prepareStep(owner, AbortSignal.any([signal, work.controller.signal])))
        await Storage.write(StoragePath.digitalTwinCursor(), { ...cursor, pending: cursor.pending.slice(1) })
    } finally {
      work.dispose()
    }
    return
  }
  if (cursor?.complete) {
    if (!instance.reconcileAfterResume) return true
    instance.reconcileAfterResume = false
    await Storage.write(StoragePath.digitalTwinCursor(), { version, complete: false })
    return
  }
  const page = await SessionCorpus.sessions({ cursor: cursor?.after, limit: 16 })
  await Storage.write(StoragePath.digitalTwinCursor(), {
    version,
    after: page.cursor,
    complete: !page.cursor,
    pending: page.items.map((session) => ({ scopeID: session.scope.id, sessionID: session.id })),
  })
}

function schedule(delay = 0) {
  const instance = state()
  if (instance.closed || instance.timer || instance.task) return
  instance.timer = setTimeout(() => {
    instance.timer = undefined
    instance.task = UpgradeWork.run({ background: true, signal: instance.controller.signal }, run)
      .catch((error) => {
        if (!instance.controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError"))
          log.warn("preparation paused", { error: error instanceof Error ? error.name : "UnknownError" })
      })
      .then((complete) => {
        if (complete) return
        if (!instance.closed)
          instance.timer = setTimeout(() => {
            instance.timer = undefined
            schedule()
          }, 50)
      })
      .finally(() => {
        instance.task = undefined
        if (instance.queue.size && !instance.closed) schedule()
      })
  }, delay)
  instance.timer.unref()
}

function observe() {
  const instance = state()
  if (instance.closed) return
  if (!instance.started) {
    instance.started = true
    const enqueue = (sessionID: string) => {
      instance.generations.set(sessionID, (instance.generations.get(sessionID) ?? 0) + 1)
      instance.projections.delete(sessionID)
      schedule()
      void Storage.readMany<{ scopeID: string }>([StoragePath.sessionIndex(Identifier.asSessionID(sessionID))])
        .then(([index]) => {
          if (!index || instance.closed) return
          instance.queue.set(sessionID, { scopeID: index.scopeID, sessionID })
          schedule()
        })
        .catch((error) => {
          if (!instance.closed)
            log.warn("source update unavailable", { error: error instanceof Error ? error.name : "UnknownError" })
        })
    }
    instance.unsubscribe = [
      Bus.subscribeGlobal(SessionEvent.Updated, ({ properties: { info } }) => enqueue(info.id)),
      Bus.subscribeGlobal(SessionEvent.Deleted, ({ properties: { info } }) => enqueue(info.id)),
      Bus.subscribeGlobal(MessageV2.Event.Updated, ({ properties: { info } }) => enqueue(info.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.Removed, ({ properties }) => enqueue(properties.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.PartUpdated, ({ properties: { part } }) => enqueue(part.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.PartRemoved, ({ properties }) => enqueue(properties.sessionID)),
    ]
  }
}

export function useCorpus(owner: { scopeID: string; sessionID: string }) {
  observe()
  const instance = state()
  if (instance.closed) return
  instance.queue.set(owner.sessionID, owner)
  schedule()
}

function publishSelection() {
  const instance = state()
  const families = familyProjections(
    [...instance.projections.entries()].map(([sessionID, value]) => ({ ...value, sessionID })),
  )
  instance.selection = {
    references: representativePool(
      families.flatMap((family) => family.references.map((entry) => ({ ...entry, family: family.family }))),
    ).map((entry) => entry.reference),
    statistics: families.map((family) => family.statistics),
    generations: families.map((value) => [value.sessionID, instance.generations.get(value.sessionID) ?? 0]),
  }
}

export async function representatives() {
  observe()
  const instance = state()
  if (!instance.closed)
    instance.loading ??= (async () => {
      const work = UpgradeWork.controller(true)
      try {
        await UpgradeWork.run(
          { background: true, signal: AbortSignal.any([instance.controller.signal, work.controller.signal]) },
          async () => {
            let after: string[] | undefined
            for (;;) {
              await UpgradeWork.checkpoint()
              const rows = await Storage.query<Projection>({ kind: "digital_twin", limit: 128, after })
              for (const row of rows) {
                await UpgradeWork.checkpoint()
                const parsed = Projection.safeParse(row.value)
                const sessionID = row.key[2]!
                const generation = instance.generations.get(sessionID) ?? 0
                if (!parsed.success || !parsed.data.ready || !(await current(parsed.data.source))) continue
                if (generation !== (instance.generations.get(sessionID) ?? 0)) continue
                instance.projections.set(sessionID, parsed.data)
              }
              publishSelection()
              if (rows.length < 128 || instance.closed) break
              after = rows.at(-1)!.key
              await new Promise<void>((resolve) => setTimeout(resolve, 0))
            }
          },
        )
      } finally {
        work.dispose()
      }
    })().catch((error) => {
      if (!instance.closed && !(error instanceof DOMException && error.name === "AbortError"))
        log.warn("projection cache unavailable", { error: error instanceof Error ? error.name : "UnknownError" })
      instance.loading = undefined
    })
  return instance.selection
}

export function representativesCurrent(bundle: Awaited<ReturnType<typeof representatives>>) {
  const instance = state()
  return bundle.generations.every(([id, generation]) => generation === (instance.generations.get(id) ?? 0))
}

export async function stopPreparation() {
  const instance = state()
  instance.closed = true
  clearTimeout(instance.timer)
  for (const unsubscribe of instance.unsubscribe) unsubscribe()
  instance.controller.abort()
  await Promise.allSettled([instance.task, instance.loading])
  instance.queue.clear()
}
