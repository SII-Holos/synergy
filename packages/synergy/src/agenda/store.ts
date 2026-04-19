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

export namespace AgendaStore {
  const log = Log.create({ service: "agenda.store" })

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
    log.info("removed", { id: itemID })
    await Bus.publish(AgendaEvent.ItemDeleted, { id: itemID, scopeID })
  }

  export async function appendRun(scopeID: string, run: AgendaTypes.RunLog): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    await Storage.write(StoragePath.agendaRun(sid, run.itemID, run.id), run)
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
