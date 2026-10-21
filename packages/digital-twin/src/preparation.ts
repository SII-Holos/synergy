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
import { original, sketch, normalize, type Sketch } from "./evidence"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"

const version = 1
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
      if (next.references.length > 24) {
        const recent = next.references.toSorted((a, b) => b.created - a.created).slice(0, 12)
        const stable = next.references
          .filter((entry) => !recent.includes(entry))
          .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
          .slice(0, 12)
        next.references = [...recent, ...stable]
      }
    }
    next.source = [...new Map(next.source.toReversed().map((source) => [JSON.stringify(source.key), source])).values()]
    next.messageCursor = page.cursor
    next.ready = !page.cursor
  }
  signal?.throwIfAborted()
  return Storage.transaction(async (tx) => {
    if ((await tx.revisions([key]))[0] !== source.revision || !(await current(next.source))) return false
    await tx.write(key, next)
    return next.ready
  })
}

async function run() {
  const instance = state()
  const signal = instance.controller.signal
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
  type Cursor = { after?: string[]; pending?: Array<{ scopeID: string; sessionID: string }>; complete?: boolean }
  const [cursor] = await Storage.readMany<Cursor>([StoragePath.digitalTwinCursor()])
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
  if (cursor?.complete) return true
  const page = await SessionCorpus.sessions({ cursor: cursor?.after, limit: 16 })
  await Storage.write(StoragePath.digitalTwinCursor(), {
    version: 1,
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
    instance.task = run()
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

export function useCorpus(owner: { scopeID: string; sessionID: string }) {
  const instance = state()
  if (instance.closed) return
  if (!instance.started) {
    instance.started = true
    const enqueue = (sessionID: string) => {
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
      Bus.subscribeGlobal(MessageV2.Event.Updated, ({ properties: { info } }) => enqueue(info.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.Removed, ({ properties }) => enqueue(properties.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.PartUpdated, ({ properties: { part } }) => enqueue(part.sessionID)),
      Bus.subscribeGlobal(MessageV2.Event.PartRemoved, ({ properties }) => enqueue(properties.sessionID)),
    ]
  }
  instance.queue.set(owner.sessionID, owner)
  schedule()
}

export async function representatives() {
  const rows = await Storage.query<Projection>({ kind: "digital_twin", limit: 128, descending: true })
  const references: SessionCorpus.Reference[] = []
  const statistics: Sketch[] = []
  const sources: Projection["source"] = []
  const families = new Map<string, Projection>()
  for (const row of rows) {
    const parsed = Projection.safeParse(row.value)
    if (!parsed.success || !parsed.data.ready || !(await current(parsed.data.source))) continue
    const previous = families.get(parsed.data.family)
    if (!previous || previous.statistics.count < parsed.data.statistics.count)
      families.set(parsed.data.family, parsed.data)
    references.push(...parsed.data.references.map((entry) => entry.reference))
  }
  for (const family of families.values()) {
    statistics.push(family.statistics)
    sources.push(...family.source)
  }
  return { references: references.slice(0, 96), statistics, sources }
}

export async function stopPreparation() {
  const instance = state()
  instance.closed = true
  clearTimeout(instance.timer)
  for (const unsubscribe of instance.unsubscribe) unsubscribe()
  instance.controller.abort()
  await instance.task
  instance.queue.clear()
}
