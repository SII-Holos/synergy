import { randomUUID } from "crypto"
import { Cron } from "croner"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { Instance } from "../scope/instance"
import { Bus } from "../bus"
import { AgendaEvent } from "./event"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"
import { Session } from "../session"

export namespace AgendaStore {
  const log = Log.create({ service: "agenda.store" })

  // ---------------------------------------------------------------------------
  // Run index — per-scope, sorted by time.started descending
  // ---------------------------------------------------------------------------

  export type RunIndexEntry = { id: string; itemID: string; started: number }
  export type RunIndex = { entries: RunIndexEntry[] }
  type IndexedRun = RunIndexEntry & { scopeID: Identifier.ScopeID }

  async function readRunIndex(scopeID: Identifier.ScopeID): Promise<RunIndex> {
    return Storage.read<RunIndex>(StoragePath.agendaRunIndex(scopeID)).catch(() => ({ entries: [] }))
  }

  async function writeRunIndex(scopeID: Identifier.ScopeID, index: RunIndex): Promise<void> {
    await Storage.write(StoragePath.agendaRunIndex(scopeID), index)
  }

  export function parseDuration(str: string): number {
    const match = str.match(/^(\d+)(ms|s|m|h|d|w)$/)
    if (!match) throw new Error(`Invalid duration format: ${str}`)
    const value = parseInt(match[1], 10)
    const unit = match[2]
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    }
    return value * multipliers[unit]
  }

  export function computeNextRunAt(triggers: AgendaTypes.Trigger[], fromTime?: number): number | undefined {
    const now = fromTime ?? Date.now()
    const candidates: number[] = []

    for (const trigger of triggers) {
      switch (trigger.type) {
        case "at": {
          if (trigger.at > now) candidates.push(trigger.at)
          break
        }
        case "delay": {
          if (fromTime !== undefined) {
            const target = fromTime + parseDuration(trigger.delay)
            if (target > now) candidates.push(target)
          }
          break
        }
        case "every": {
          const intervalMs = parseDuration(trigger.interval)
          if (trigger.anchor !== undefined) {
            const elapsed = now - trigger.anchor
            const ticks = Math.ceil(elapsed / intervalMs)
            const next = trigger.anchor + ticks * intervalMs
            candidates.push(next <= now ? next + intervalMs : next)
          } else {
            candidates.push(now + intervalMs)
          }
          break
        }
        case "cron": {
          const next = new Cron(trigger.expr, { timezone: trigger.tz }).nextRun()
          if (next) candidates.push(next.getTime())
          break
        }
      }
    }

    if (candidates.length === 0) return undefined
    return Math.min(...candidates)
  }

  export async function create(
    input: AgendaTypes.CreateInput,
    id: string = Identifier.ascending("agenda"),
  ): Promise<AgendaTypes.Item> {
    const scope = Instance.scope
    const now = Date.now()
    const triggers = input.triggers ?? []

    for (const trigger of triggers) {
      if (trigger.type === "webhook" && !trigger.token) {
        trigger.token = randomUUID()
      }
    }

    const item: AgendaTypes.Item = {
      id,
      status: triggers.length > 0 ? "active" : "pending",
      title: input.title,
      description: input.description,
      tags: input.tags,
      global: input.global ?? false,
      triggers,
      prompt: input.prompt,
      agent: input.agent,
      model: input.model,
      sessionRefs: input.sessionRefs,
      timeout: input.timeout,
      wake: input.wake ?? true,
      silent: input.silent ?? false,
      autoDone: input.autoDone ?? false,
      origin: { scope, sessionID: input.sessionID, endpoint: input.endpoint },
      createdBy: input.createdBy ?? "user",
      state: {
        consecutiveErrors: 0,
        runCount: 0,
        nextRunAt: computeNextRunAt(triggers, now),
      },
      time: { created: now, updated: now },
    }

    const scopeID = Identifier.asScopeID(item.global ? "global" : scope.id)
    await Storage.write(StoragePath.agendaItem(scopeID, id), item)
    log.info("created", { id, title: input.title, global: item.global })
    await Bus.publish(AgendaEvent.ItemCreated, { item })
    return item
  }

  export async function get(scopeID: string, itemID: string): Promise<AgendaTypes.Item> {
    return Storage.read<AgendaTypes.Item>(StoragePath.agendaItem(Identifier.asScopeID(scopeID), itemID))
  }

  export async function list(scopeID: string): Promise<AgendaTypes.Item[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.agendaItemsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.agendaItem(sid, id))
    const results = await Storage.readMany<AgendaTypes.Item>(keys)
    const items = results.filter((item): item is AgendaTypes.Item => item !== undefined)
    items.sort((a, b) => b.time.created - a.time.created)
    return items
  }

  export async function listForScope(scopeID: string): Promise<AgendaTypes.Item[]> {
    if (scopeID === "global") return list("global")
    const [scoped, global] = await Promise.all([list(scopeID), list("global")])
    return [...scoped, ...global].sort((a, b) => b.time.created - a.time.created)
  }

  export async function update(
    scopeID: string,
    itemID: string,
    patch: AgendaTypes.PatchInput,
    options?: { recomputeNextRunAt?: boolean },
  ): Promise<AgendaTypes.Item> {
    const sid = Identifier.asScopeID(scopeID)
    const item = await Storage.update<AgendaTypes.Item>(StoragePath.agendaItem(sid, itemID), (draft) => {
      if (patch.title !== undefined) draft.title = patch.title
      if (patch.description !== undefined) draft.description = patch.description
      if (patch.status !== undefined) draft.status = patch.status
      if (patch.tags !== undefined) draft.tags = patch.tags
      if (patch.triggers !== undefined) {
        for (const trigger of patch.triggers) {
          if (trigger.type === "webhook" && !trigger.token) {
            trigger.token = randomUUID()
          }
        }
        draft.triggers = patch.triggers
        draft.state.nextRunAt = computeNextRunAt(patch.triggers)
      }
      if (patch.prompt !== undefined) draft.prompt = patch.prompt
      if (patch.global !== undefined) draft.global = patch.global
      if (patch.wake !== undefined) draft.wake = patch.wake
      if (patch.silent !== undefined) draft.silent = patch.silent
      if (patch.agent !== undefined) draft.agent = patch.agent
      if (patch.sessionRefs !== undefined) draft.sessionRefs = patch.sessionRefs
      if (options?.recomputeNextRunAt) {
        draft.state.nextRunAt = computeNextRunAt(draft.triggers)
      }
      draft.time.updated = Date.now()
    })
    log.info("updated", { id: itemID })
    await Bus.publish(AgendaEvent.ItemUpdated, { item })
    return item
  }

  export async function updateRunState(
    scopeID: string,
    itemID: string,
    result: {
      status: AgendaTypes.RunStatus
      error?: string
      sessionID?: string
      startTime: number
      duration: number
    },
    triggers: AgendaTypes.Trigger[],
    signalType: string,
  ): Promise<{ item: AgendaTypes.Item; nextRunAt: number | undefined }> {
    const sid = Identifier.asScopeID(scopeID)
    const newNextRunAt = computeNextRunAt(triggers)
    const item = await Storage.update<AgendaTypes.Item>(StoragePath.agendaItem(sid, itemID), (draft) => {
      draft.state.lastRunAt = result.startTime
      draft.state.lastRunStatus = result.status
      draft.state.lastRunError = result.error
      draft.state.lastRunDuration = result.duration
      draft.state.lastRunSessionID = result.sessionID
      draft.state.runCount++

      if (result.status === "error") {
        draft.state.consecutiveErrors++
      } else {
        draft.state.consecutiveErrors = 0
      }

      draft.state.nextRunAt = newNextRunAt

      const hasNonTimeTriggers = triggers.some((t) => t.type === "watch" || t.type === "webhook")
      if (newNextRunAt === undefined && signalType !== "manual" && !hasNonTimeTriggers) {
        draft.status = "done"
      }

      draft.time.updated = Date.now()
    })
    await Bus.publish(AgendaEvent.ItemUpdated, { item })
    return { item, nextRunAt: newNextRunAt }
  }

  export async function remove(scopeID: string, itemID: string): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    await Storage.remove(StoragePath.agendaItem(sid, itemID))
    await Storage.removeTree(StoragePath.agendaRunsRoot(sid, itemID))
    const index = await readRunIndex(sid)
    if (index.entries.length > 0) {
      index.entries = index.entries.filter((e) => e.itemID !== itemID)
      await writeRunIndex(sid, index)
    }
    log.info("removed", { id: itemID })
    await Bus.publish(AgendaEvent.ItemDeleted, { id: itemID, scopeID })
  }

  export async function appendRun(scopeID: string, run: AgendaTypes.RunLog): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    await Storage.write(StoragePath.agendaRun(sid, run.itemID, run.id), run)
    const index = await readRunIndex(sid)
    // New runs always have the latest started time, so unshift preserves descending order
    index.entries.unshift({ id: run.id, itemID: run.itemID, started: run.time.started })
    await writeRunIndex(sid, index)
  }

  export async function listRuns(scopeID: string, itemID: string): Promise<AgendaTypes.RunLog[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.agendaRunsRoot(sid, itemID))
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.agendaRun(sid, itemID, id))
    const results = await Storage.readMany<AgendaTypes.RunLog>(keys)
    const runs = results.filter((run): run is AgendaTypes.RunLog => run !== undefined)
    runs.sort((a, b) => b.time.started - a.time.started)
    return runs
  }

  async function getSessionSummary(sessionID: string): Promise<AgendaTypes.ActivitySession | undefined> {
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
    if (!indexed) return undefined
    const session = await Storage.read<Session.Info>(
      StoragePath.sessionInfo(Identifier.asScopeID(indexed.scopeID), Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
    if (!session) return undefined
    return {
      id: session.id,
      scopeID: indexed.scopeID,
      title: session.title,
      time: {
        created: session.time.created,
        updated: session.time.updated,
        archived: session.time.archived,
      },
    }
  }

  function toActivityAgenda(item: AgendaTypes.Item, scopeID: string): AgendaTypes.ActivityAgenda {
    return {
      id: item.id,
      scopeID,
      title: item.title,
      description: item.description,
      status: item.status,
      tags: item.tags,
      global: item.global,
      time: {
        created: item.time.created,
        updated: item.time.updated,
      },
    }
  }

  function matchesActivityQuery(
    run: AgendaTypes.RunLog,
    item: AgendaTypes.Item,
    session: AgendaTypes.ActivitySession | undefined,
    query: string | undefined,
  ) {
    if (!query) return true
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const haystacks = [
      item.id,
      item.title,
      item.description,
      ...(item.tags ?? []),
      run.id,
      run.status,
      run.trigger.type,
      run.trigger.source,
      run.sessionID,
      run.error,
      session?.id,
      session?.title,
    ]
    return haystacks.some((value) => value?.toLowerCase().includes(needle))
  }

  export async function listActivity(input?: {
    scopeID?: string
    itemID?: string
    query?: string
    offset?: number
    limit?: number
  }): Promise<AgendaTypes.ActivityPage> {
    const offset = input?.offset ?? 0
    const limit = input?.limit ?? 50

    // Single-item shortcut — falls back to per-item scan
    if (input?.itemID) {
      const { item, scopeID } = await find(input.itemID)
      const runs = await listRuns(scopeID, item.id)
      const sessions = await loadSessionSummaries(runs.map((r) => r.sessionID).filter(Boolean) as string[])
      const filtered = input.query
        ? runs.filter((run) =>
            matchesActivityQuery(run, item, run.sessionID ? sessions.get(run.sessionID) : undefined, input.query),
          )
        : runs
      filtered.sort((a, b) => b.time.started - a.time.started)
      const page = filtered.slice(offset, offset + limit)
      return {
        items: page.map((run) => ({
          run,
          agenda: toActivityAgenda(item, scopeID),
          session: run.sessionID ? sessions.get(run.sessionID) : undefined,
        })),
        total: filtered.length,
        limit,
        offset,
        hasMore: offset + page.length < filtered.length,
      }
    }

    // Determine which scopes to query
    const scopeIDs = input?.scopeID
      ? input.scopeID === "global"
        ? [Identifier.asScopeID("global")]
        : [Identifier.asScopeID(input.scopeID), Identifier.asScopeID("global")]
      : await Storage.scan(["agenda", "items"])

    // Collect index entries from all relevant scopes
    const allEntries: IndexedRun[] = []
    for (const rawScopeID of scopeIDs) {
      const sid = Identifier.asScopeID(rawScopeID)
      const index = await readRunIndex(sid)
      allEntries.push(...index.entries.map((e) => ({ ...e, scopeID: sid })))
    }
    allEntries.sort((a, b) => b.started - a.started)

    // If query is present, we need to load runs and filter — but only scan
    // through enough entries to fill the page (with over-fetch headroom)
    if (input?.query) {
      return listActivityWithQuery(allEntries, input.query, offset, limit)
    }

    // No query — direct slice from index
    const page = allEntries.slice(offset, offset + limit)
    const results = await loadActivityEntries(page)

    return {
      items: results,
      total: allEntries.length,
      limit,
      offset,
      hasMore: offset + page.length < allEntries.length,
    }
  }

  async function listActivityWithQuery(
    entries: IndexedRun[],
    query: string,
    offset: number,
    limit: number,
  ): Promise<AgendaTypes.ActivityPage> {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      const page = entries.slice(offset, offset + limit)
      return {
        items: await loadActivityEntries(page),
        total: entries.length,
        limit,
        offset,
        hasMore: offset + page.length < entries.length,
      }
    }

    // Batch-load runs and items, filter in batches, collect matched entries.
    // We must scan all entries to get an accurate total count.
    const matched: IndexedRun[] = []
    const batchSize = 50

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      const runs = await Promise.all(
        batch.map((e) =>
          Storage.read<AgendaTypes.RunLog>(StoragePath.agendaRun(e.scopeID, e.itemID, e.id)).catch(() => undefined),
        ),
      )

      // Load items grouped by scopeID
      const itemsByScope = new Map<Identifier.ScopeID, Map<string, AgendaTypes.Item>>()
      for (const entry of batch) {
        if (!itemsByScope.has(entry.scopeID)) itemsByScope.set(entry.scopeID, new Map())
      }
      for (const [scopeID, itemMap] of itemsByScope) {
        const itemIDs = [...new Set(batch.filter((e) => e.scopeID === scopeID).map((e) => e.itemID))]
        const loaded = await loadAgendaItems(scopeID, itemIDs)
        for (const [id, item] of loaded) itemMap.set(id, item)
      }

      // Load sessions for this batch so query can match session titles
      const sessionIDs = runs
        .filter((r): r is AgendaTypes.RunLog => r !== undefined && !!r.sessionID)
        .map((r) => r.sessionID!)
      const sessions = await loadSessionSummaries([...new Set(sessionIDs)])

      for (let j = 0; j < batch.length; j++) {
        const run = runs[j]
        if (!run) continue
        const item = itemsByScope.get(batch[j].scopeID)?.get(batch[j].itemID)
        if (!item) continue
        const session = run.sessionID ? sessions.get(run.sessionID) : undefined
        if (matchesActivityQuery(run, item, session, query)) {
          matched.push(batch[j])
        }
      }
    }

    const page = matched.slice(offset, offset + limit)
    const results = await loadActivityEntries(page)
    return {
      items: results,
      total: matched.length,
      limit,
      offset,
      hasMore: offset + page.length < matched.length,
    }
  }

  async function loadActivityEntries(entries: IndexedRun[]): Promise<AgendaTypes.ActivityEntry[]> {
    if (entries.length === 0) return []

    const runs = await Promise.all(
      entries.map((e) =>
        Storage.read<AgendaTypes.RunLog>(StoragePath.agendaRun(e.scopeID, e.itemID, e.id)).catch(() => undefined),
      ),
    )

    // Batch-load agenda items — group by scopeID
    const itemsByScope = new Map<string, Map<string, AgendaTypes.Item>>()
    for (const entry of entries) {
      const key = entry.scopeID as string
      if (!itemsByScope.has(key)) itemsByScope.set(key, new Map())
    }
    for (const [scopeID, itemMap] of itemsByScope) {
      const sid = Identifier.asScopeID(scopeID)
      const itemIDs = [...new Set(entries.filter((e) => e.scopeID === sid).map((e) => e.itemID))]
      const keys = itemIDs.map((id) => StoragePath.agendaItem(sid, id))
      const results = await Storage.readMany<AgendaTypes.Item>(keys)
      for (let i = 0; i < itemIDs.length; i++) {
        if (results[i]) itemMap.set(itemIDs[i], results[i]!)
      }
    }

    const sessionIDs = runs
      .filter((r): r is AgendaTypes.RunLog => r !== undefined && !!r.sessionID)
      .map((r) => r.sessionID!)
    const sessions = await loadSessionSummaries([...new Set(sessionIDs)])

    const result: AgendaTypes.ActivityEntry[] = []
    for (let i = 0; i < entries.length; i++) {
      const run = runs[i]
      const item = itemsByScope.get(entries[i].scopeID as string)?.get(entries[i].itemID)
      if (!run || !item) continue
      result.push({
        run,
        agenda: toActivityAgenda(item, entries[i].scopeID as string),
        session: run.sessionID ? sessions.get(run.sessionID) : undefined,
      })
    }
    return result
  }

  async function loadAgendaItems(
    scopeID: Identifier.ScopeID | undefined,
    itemIDs: string[],
  ): Promise<Map<string, AgendaTypes.Item>> {
    const result = new Map<string, AgendaTypes.Item>()
    if (!scopeID || itemIDs.length === 0) return result
    const keys = itemIDs.map((id) => StoragePath.agendaItem(scopeID, id))
    const items = await Storage.readMany<AgendaTypes.Item>(keys)
    for (let i = 0; i < itemIDs.length; i++) {
      if (items[i]) result.set(itemIDs[i], items[i]!)
    }
    return result
  }

  async function loadSessionSummaries(sessionIDs: string[]): Promise<Map<string, AgendaTypes.ActivitySession>> {
    const result = new Map<string, AgendaTypes.ActivitySession>()
    if (sessionIDs.length === 0) return result
    await Promise.all(
      sessionIDs.map(async (sessionID) => {
        const session = await getSessionSummary(sessionID)
        if (session) result.set(sessionID, session)
      }),
    )
    return result
  }

  export async function loadActive(): Promise<AgendaTypes.Item[]> {
    const scopeIDs = await Storage.scan(["agenda", "items"])
    const batches = await Promise.all(scopeIDs.map((scopeID) => list(scopeID)))
    return batches.flat().filter((item) => item.status === "active")
  }

  export async function listAll(): Promise<AgendaTypes.Item[]> {
    const scopeIDs = await Storage.scan(["agenda", "items"])
    const batches = await Promise.all(scopeIDs.map((scopeID) => list(scopeID)))
    return batches.flat().sort((a, b) => b.time.created - a.time.created)
  }

  export async function find(itemID: string): Promise<{ item: AgendaTypes.Item; scopeID: string }> {
    const scopeIDs = await Storage.scan(["agenda", "items"])
    for (const scopeID of scopeIDs) {
      const sid = Identifier.asScopeID(scopeID)
      const item = await Storage.read<AgendaTypes.Item>(StoragePath.agendaItem(sid, itemID)).catch(() => undefined)
      if (item) return { item, scopeID }
    }
    throw new Error(`Agenda item not found: ${itemID}`)
  }

  export async function findInScope(
    scopeID: string,
    itemID: string,
  ): Promise<{ item: AgendaTypes.Item; scopeID: string }> {
    const sid = Identifier.asScopeID(scopeID)
    const item = await Storage.read<AgendaTypes.Item>(StoragePath.agendaItem(sid, itemID)).catch(() => undefined)
    if (item) return { item, scopeID }
    if (scopeID !== "global") {
      const globalSid = Identifier.asScopeID("global")
      const globalItem = await Storage.read<AgendaTypes.Item>(StoragePath.agendaItem(globalSid, itemID)).catch(
        () => undefined,
      )
      if (globalItem) return { item: globalItem, scopeID: "global" }
    }
    throw new Error(`Agenda item not found: ${itemID}`)
  }

  export async function listSessions(itemID: string): Promise<{ sessionID: string; scopeID: string }[]> {
    const ids = await Storage.scan(StoragePath.agendaSessionsRoot(itemID))
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.agendaSession(itemID, id))
    const results = await Storage.readMany<{ sessionID: string; scopeID: string }>(keys)
    return results.filter((r): r is { sessionID: string; scopeID: string } => r !== undefined)
  }

  export async function setPersistentSession(scopeID: string, itemID: string, sessionID: string): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    await Storage.update<AgendaTypes.Item>(StoragePath.agendaItem(sid, itemID), (draft) => {
      draft.state.persistentSessionID = sessionID
      draft.time.updated = Date.now()
    })
  }
}
