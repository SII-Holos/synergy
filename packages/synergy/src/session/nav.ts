import z from "zod"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import type { Info as SessionInfo } from "./types"

export type NavCategory = "project" | "home" | "channel" | "background"
export const NavCategory = z.enum(["project", "home", "channel", "background"])

export interface DeriveCategoryInput {
  scopeType: "global" | "project"
  endpointKind?: "channel" | "holos"
  parentID?: string
  cortex?: {
    parentSessionID: string
    parentMessageID: string
    description: string
    agent: string
    startedAt: number
    status: string
    completedAt?: number
    model?: { providerID: string; modelID: string }
    result?: string
    error?: string
  }
  agenda?: { itemID: string }
}

export interface SessionNavEntry {
  id: string
  scopeID: string
  scopeType: "global" | "project"
  title: string
  category: NavCategory
  lastActivityAt: number
  pinned: number
  archived: boolean
  parentID?: string
}
export interface ScopeNavEntry {
  scopeID: string
  scopeType: "global" | "project"
  name?: string
  directory: string
  latestActivityAt: number
  sessionCount: number
  icon?: { url?: string; color?: string }
}
export interface ScopeNavIndex {
  version: 1
  scopeID: string
  updatedAt: number
  entries: SessionNavEntry[]
}
export interface NavCursor {
  lastActivityAt: number
  id: string
}

export namespace SessionNav {
  const log = Log.create({ service: "session.nav" })

  export function deriveCategory(input: DeriveCategoryInput): NavCategory {
    if (input.endpointKind === "channel" || input.endpointKind === "holos") return "channel"
    if (input.parentID || input.cortex || input.agenda) return "background"
    if (input.scopeType === "global") return "home"
    return "project"
  }

  export function paginateWithCursor(
    entries: SessionNavEntry[],
    opts: { cursor?: NavCursor | null; limit?: number },
  ): { items: SessionNavEntry[]; nextCursor: NavCursor | null; total: number } {
    const limit = opts.limit ?? 20
    const total = entries.length
    let startIdx = 0
    if (opts.cursor) {
      const c = opts.cursor
      startIdx = entries.findIndex(
        (e) => e.lastActivityAt < c.lastActivityAt || (e.lastActivityAt === c.lastActivityAt && e.id < c.id),
      )
      if (startIdx === -1) startIdx = entries.length
    }
    const slice = entries.slice(startIdx, startIdx + limit)
    const hasMore = startIdx + slice.length < total
    const last = slice.at(-1)
    const nextCursor: NavCursor | null = hasMore && last ? { lastActivityAt: last.lastActivityAt, id: last.id } : null
    return { items: slice, nextCursor, total }
  }

  export async function buildNavIndex(scopeID: string): Promise<ScopeNavIndex> {
    const sid = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(sid))
    const entries: SessionNavEntry[] = []
    if (sessionIDs.length > 0) {
      const keys = sessionIDs.map((id) => StoragePath.sessionInfo(sid, Identifier.asSessionID(id)))
      const sessions = await Storage.readMany<SessionInfo>(keys)
      for (const session of sessions) {
        if (!session || !session.scope) {
          log.warn("skipping malformed session info", { scopeID })
          continue
        }
        const s = session.scope as { id: string; type?: string }
        const st: "global" | "project" = s.id === "global" ? "global" : "project"
        const category = deriveCategory({
          scopeType: st,
          endpointKind: session.endpoint?.kind,
          parentID: session.parentID,
          cortex: session.cortex,
          agenda: session.agenda,
        })
        if (!session.category) {
          await Storage.write(StoragePath.sessionInfo(sid, Identifier.asSessionID(session.id)), {
            ...session,
            category,
          })
        }
        entries.push({
          id: session.id,
          scopeID,
          scopeType: st,
          title: session.title,
          category,
          lastActivityAt: session.time.updated,
          pinned: session.pinned ?? 0,
          archived: !!session.time.archived,
          parentID: session.parentID,
        })
      }
    }
    entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
    const index: ScopeNavIndex = { version: 1, scopeID, updatedAt: Date.now(), entries }
    await Storage.write(StoragePath.sessionNavIndex(sid), index)
    return index
  }

  export async function readNavIndex(scopeID: string): Promise<ScopeNavIndex> {
    const sid = Identifier.asScopeID(scopeID)
    const key = StoragePath.sessionNavIndex(sid)
    const existing = await Storage.read<ScopeNavIndex>(key).catch(() => undefined)
    if (existing) return existing
    return buildNavIndex(scopeID).catch<ScopeNavIndex>((error) => {
      log.warn("failed to lazily build nav index", { scopeID, error: String(error) })
      return { version: 1, scopeID, updatedAt: 0, entries: [] }
    })
  }

  export async function rebuildAllNavIndexes(progress?: (done: number, total: number) => void): Promise<void> {
    const sessionScopeIDs = await Storage.scan(["sessions"])
    const allScopeIDs = [...sessionScopeIDs]
    if (!allScopeIDs.includes("global")) allScopeIDs.push("global")
    const total = allScopeIDs.length
    let done = 0
    for (const scopeID of allScopeIDs) {
      try {
        await buildNavIndex(scopeID)
      } catch (err) {
        log.warn("failed to build nav index for scope", { scopeID, error: String(err) })
      }
      done++
      progress?.(done, total)
    }
  }

  async function getAllScopeIDs(): Promise<string[]> {
    const { Scope } = await import("../scope")
    const projects = await Scope.list()
    const sessionScopeIDs = await Storage.scan(["sessions"])
    return [...new Set(["global", ...projects.map((p) => p.id), ...sessionScopeIDs])]
  }

  async function getProjectScopeIDs(): Promise<string[]> {
    const ids = await getAllScopeIDs()
    return ids.filter((id) => id !== "global")
  }

  export async function queryScope(
    scopeID: string,
    opts?: {
      parentOnly?: boolean
      category?: NavCategory
      includeArchived?: boolean
      cursor?: NavCursor
      limit?: number
    },
  ): Promise<{ items: SessionNavEntry[]; nextCursor: NavCursor | null; total: number }> {
    const index = await readNavIndex(scopeID)
    let entries = index.entries
    if (opts?.parentOnly ?? true) entries = entries.filter((e) => !e.parentID)
    if (opts?.category) entries = entries.filter((e) => e.category === opts.category)
    if (!opts?.includeArchived) entries = entries.filter((e) => !e.archived)
    return paginateWithCursor(entries, { cursor: opts?.cursor ?? null, limit: opts?.limit })
  }

  export async function queryGlobal(opts?: {
    parentOnly?: boolean
    includeArchived?: boolean
    search?: string
    cursor?: NavCursor
    limit?: number
  }): Promise<{ items: SessionNavEntry[]; nextCursor: NavCursor | null; total: number }> {
    const scopeIDs = await getProjectScopeIDs()
    const allEntries: SessionNavEntry[] = []
    for (const sid of scopeIDs) {
      const index = await readNavIndex(sid)
      allEntries.push(...index.entries)
    }
    allEntries.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
    let entries = allEntries
    if (opts?.parentOnly ?? true) entries = entries.filter((e) => !e.parentID)
    if (!opts?.includeArchived) entries = entries.filter((e) => !e.archived)
    if (opts?.search) {
      const term = opts.search.toLowerCase()
      entries = entries.filter((e) => e.title.toLowerCase().includes(term))
    }
    return paginateWithCursor(entries, { cursor: opts?.cursor ?? null, limit: opts?.limit })
  }

  export async function queryPinned(opts?: { limit?: number }): Promise<{ items: SessionNavEntry[]; total: number }> {
    const scopeIDs = await getAllScopeIDs()
    const allEntries: SessionNavEntry[] = []
    for (const sid of scopeIDs) {
      const index = await readNavIndex(sid)
      allEntries.push(...index.entries)
    }
    const pinned = allEntries.filter((e) => e.pinned > 0 && !e.archived)
    pinned.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
    const limit = opts?.limit ?? pinned.length
    return { items: pinned.slice(0, limit), total: pinned.length }
  }

  export async function buildScopeIndex(): Promise<ScopeNavEntry[]> {
    const scopeIDs = await getAllScopeIDs()
    const results: ScopeNavEntry[] = []
    for (const sid of scopeIDs) {
      const index = await readNavIndex(sid)
      const activeEntries = index.entries.filter((e) => !e.archived)
      let scopeInfo:
        | { name?: string; icon?: { url?: string; color?: string }; directory?: string; worktree?: string }
        | undefined
      if (sid !== "global") {
        scopeInfo = await Storage.read<any>(StoragePath.scope(Identifier.asScopeID(sid))).catch(() => undefined)
      }
      const latestActivityAt = activeEntries.length > 0 ? Math.max(...activeEntries.map((e) => e.lastActivityAt)) : 0
      results.push({
        scopeID: sid,
        scopeType: sid === "global" ? "global" : "project",
        name: scopeInfo?.name,
        directory: sid === "global" ? "" : (scopeInfo?.directory ?? ""),
        latestActivityAt,
        sessionCount: activeEntries.length,
        icon: scopeInfo?.icon,
      })
    }
    results.sort((a, b) => b.latestActivityAt - a.latestActivityAt || a.scopeID.localeCompare(b.scopeID))
    return results
  }

  export async function upsertNavEntry(entry: SessionNavEntry): Promise<void> {
    const index = await readNavIndex(entry.scopeID)
    const existing = index.entries.findIndex((e) => e.id === entry.id)
    if (existing >= 0) index.entries.splice(existing, 1)
    const insertAt = index.entries.findIndex(
      (e) => e.lastActivityAt < entry.lastActivityAt || (e.lastActivityAt === entry.lastActivityAt && e.id < entry.id),
    )
    if (insertAt === -1) index.entries.push(entry)
    else index.entries.splice(insertAt, 0, entry)
    index.updatedAt = Date.now()
    await Storage.write(StoragePath.sessionNavIndex(Identifier.asScopeID(entry.scopeID)), index)
  }

  export async function removeNavEntry(scopeID: string, sessionID: string): Promise<void> {
    const index = await readNavIndex(scopeID)
    index.entries = index.entries.filter((e) => e.id !== sessionID)
    index.updatedAt = Date.now()
    await Storage.write(StoragePath.sessionNavIndex(Identifier.asScopeID(scopeID)), index)
  }
}
