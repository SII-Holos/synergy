import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { SessionNav, type SessionNavEntry } from "../session/nav"
import { Scope } from "../scope"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import type { Info as SessionInfo } from "../session/types"
import type { Info as ScopeInfo } from "../scope/types"
import { errors } from "./error"

const { asScopeID, asSessionID } = Identifier

const GlobalSessionItem = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.object({
    id: z.string(),
    type: z.enum(["home", "project"]),
    directory: z.string(),
    worktree: z.string(),
    name: z.string().optional(),
    icon: z.object({ url: z.string().optional(), color: z.string().optional() }).optional(),
  }),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    archived: z.number().optional(),
  }),
  pinned: z.number().optional(),
  parentID: z.string().optional(),
  lastExchange: z.object({ user: z.string().optional(), assistant: z.string().optional() }).optional(),
})

type GlobalSessionItem = z.infer<typeof GlobalSessionItem>
type ArchivedFilter = "exclude" | "include" | "only"
type SessionSortBy = "updated" | "created" | "archived" | "scope"
type SortDir = "asc" | "desc"

async function readScopeInfo(scopeID: string): Promise<z.infer<typeof Scope.Info> | undefined> {
  if (scopeID === "home") return undefined
  return Storage.read<z.infer<typeof Scope.Info>>(StoragePath.scope(asScopeID(scopeID))).catch(() => undefined)
}

function buildScopeField(
  scope: Scope.Home | Scope.Project,
  persisted: z.infer<typeof Scope.Info> | undefined,
): GlobalSessionItem["scope"] {
  return {
    id: scope.id,
    type: scope.type,
    directory: scope.directory,
    worktree: scope.worktree,
    name: persisted?.name ?? (scope as Scope.Project).name,
    icon: persisted?.icon ?? (scope as Scope.Project).icon,
  }
}

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined) return defaultVal
  if (raw === "true" || raw === "1") return true
  if (raw === "false" || raw === "0") return false
  return defaultVal
}

function resolveArchivedFilter(query: { archived?: ArchivedFilter; includeArchived?: string }): ArchivedFilter {
  if (query.archived) return query.archived
  return parseBool(query.includeArchived, false) ? "include" : "exclude"
}

function compareNumber(a: number | undefined, b: number | undefined, dir: SortDir) {
  const left = a ?? 0
  const right = b ?? 0
  return dir === "asc" ? left - right : right - left
}

function scopeSortLabel(scopeID: string, scopeInfo: ScopeInfo | undefined) {
  if (scopeID === "home") return "Home"
  return scopeInfo?.name || scopeInfo?.directory || scopeID
}
function titleMatchRank(title: string, term: string) {
  const lower = title.toLowerCase()
  if (lower.startsWith(term)) return 0
  const idx = lower.indexOf(term)
  if (idx > 0 && !/[a-z0-9]/.test(lower[idx - 1])) return 1
  return 2
}

function entryUpdatedAt(entry: SessionNavEntry) {
  return entry.updatedAt ?? entry.lastActivityAt
}

export const GlobalSessionRoute = new Hono().get(
  "/",
  describeRoute({
    summary: "Global session search",
    description: "Search sessions across all scopes, sorted by most recently updated.",
    operationId: "global.session.search",
    responses: {
      200: {
        description: "Paginated cross-scope session list",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: GlobalSessionItem.array(),
                total: z.number(),
                offset: z.number(),
                limit: z.number(),
              }),
            ),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator(
    "query",
    z.object({
      search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
      offset: z.coerce.number().default(0).meta({ description: "Number of sessions to skip" }),
      limit: z.coerce.number().default(20).meta({ description: "Maximum number of sessions to return (1-100)" }),
      scopeID: z.string().optional().meta({ description: "Filter to a single scope" }),
      parentOnly: z.string().optional().meta({ description: "Only top-level sessions (default: true)" }),
      includeArchived: z.string().optional().meta({ description: "Include archived sessions (default: false)" }),
      archived: z
        .enum(["exclude", "include", "only"])
        .optional()
        .meta({ description: "Archived session filter. Defaults to exclude; supersedes includeArchived." }),
      sortBy: z
        .enum(["updated", "created", "archived", "scope"])
        .default("updated")
        .meta({ description: "Sort sessions by timestamp or scope label" }),
      sortDir: z.enum(["asc", "desc"]).default("desc").meta({ description: "Sort direction" }),
    }),
  ),
  async (c) => {
    const raw = c.req.query()
    const query = c.req.valid("query")

    // Parse booleans manually: z.coerce.boolean() converts "false" -> true
    const parentOnly = parseBool(query.parentOnly, true)
    const archivedFilter = resolveArchivedFilter(query)

    // Validate offset: negative => 400
    if (raw.offset !== undefined) {
      const parsed = Number(raw.offset)
      if (!Number.isFinite(parsed) || parsed < 0) {
        return c.json({ message: "offset must be non-negative" }, 400)
      }
    }

    // Clamp limit to [1, 100]
    const limit = Math.min(Math.max(query.limit, 1), 100)

    // Build scope list
    let scopeIDs: string[]
    if (query.scopeID) {
      scopeIDs = [query.scopeID]
    } else {
      const projects = await Scope.list()
      scopeIDs = ["home", ...projects.map((p) => p.id)]
    }

    const scopeInfoCache = new Map<string, z.infer<typeof Scope.Info> | undefined>()
    await Promise.all(
      scopeIDs.map(async (sid) => {
        scopeInfoCache.set(sid, await readScopeInfo(sid))
      }),
    )

    // Filter and sort entirely on nav indexes; session infos are read only for
    // the returned page and for legacy indexes that predate entry timestamps.
    const indexes = await Promise.all(scopeIDs.map((sid) => SessionNav.readNavIndex(sid)))
    let pageEntries: SessionNavEntry[] = indexes.flatMap((index) => index.entries)

    if (archivedFilter === "exclude") pageEntries = pageEntries.filter((entry) => !entry.archived)
    if (archivedFilter === "only") pageEntries = pageEntries.filter((entry) => entry.archived)
    if (parentOnly) pageEntries = pageEntries.filter((entry) => !entry.parentID)

    const term = query.search?.trim().toLowerCase()
    if (term) {
      pageEntries = pageEntries.filter((entry) => entry.title.toLowerCase().includes(term))
    }

    if (
      pageEntries.length > 0 &&
      pageEntries.some((entry) => entry.createdAt === undefined || entry.updatedAt === undefined)
    ) {
      const backfill = await Storage.readMany<SessionInfo>(
        pageEntries.map((entry) => StoragePath.sessionInfo(asScopeID(entry.scopeID), asSessionID(entry.id))),
      )
      pageEntries = pageEntries.map((entry, i) => {
        const info = backfill[i]
        if (!info?.scope) return entry
        return {
          ...entry,
          createdAt: entry.createdAt ?? info.time.created,
          updatedAt: entry.updatedAt ?? info.time.updated,
          archivedAt: entry.archivedAt ?? (info.time.archived || undefined),
        }
      })
    }

    if (term && raw.sortBy === undefined) {
      pageEntries.sort((a, b) => {
        const rank = titleMatchRank(a.title, term) - titleMatchRank(b.title, term)
        if (rank !== 0) return rank
        const updated = compareNumber(entryUpdatedAt(a), entryUpdatedAt(b), "desc")
        if (updated !== 0) return updated
        return b.id.localeCompare(a.id)
      })
    } else {
      pageEntries.sort((a, b) => {
        let result = 0
        switch (query.sortBy as SessionSortBy) {
          case "created":
            result = compareNumber(a.createdAt, b.createdAt, query.sortDir as SortDir)
            break
          case "archived":
            result = compareNumber(a.archivedAt, b.archivedAt, query.sortDir as SortDir)
            break
          case "scope": {
            const aScope = scopeSortLabel(a.scopeID, scopeInfoCache.get(a.scopeID))
            const bScope = scopeSortLabel(b.scopeID, scopeInfoCache.get(b.scopeID))
            result = query.sortDir === "asc" ? aScope.localeCompare(bScope) : bScope.localeCompare(aScope)
            break
          }
          case "updated":
            result = compareNumber(entryUpdatedAt(a), entryUpdatedAt(b), query.sortDir as SortDir)
            break
        }
        if (result !== 0) return result
        const updated = compareNumber(entryUpdatedAt(a), entryUpdatedAt(b), "desc")
        if (updated !== 0) return updated
        return compareNumber(a.createdAt, b.createdAt, "desc")
      })
    }

    const total = pageEntries.length

    // Paginate
    const offset = query.offset ?? 0
    const slice = pageEntries.slice(offset, offset + limit)

    const infos = slice.length
      ? await Storage.readMany<SessionInfo>(
          slice.map((entry) => StoragePath.sessionInfo(asScopeID(entry.scopeID), asSessionID(entry.id))),
        )
      : []

    // Build response
    const data: GlobalSessionItem[] = slice.flatMap((entry, i) => {
      const info = infos[i]
      // An entry whose info file is gone is an orphan from an interrupted
      // delete; the authoritative record wins and the entry is skipped.
      if (!info?.scope) return []
      const scopeInfo = scopeInfoCache.get(entry.scopeID)
      const scope: Scope =
        entry.scopeID === "home"
          ? Scope.home()
          : {
              type: "project" as const,
              id: entry.scopeID,
              directory: scopeInfo?.directory ?? "",
              worktree: scopeInfo?.worktree ?? "",
              sandboxes: scopeInfo?.sandboxes ?? [],
              time: scopeInfo?.time ?? { created: 0, updated: 0 },
            }

      const archived = entry.archivedAt ?? info.time.archived
      return [
        {
          id: entry.id,
          title: info.title,
          scope: buildScopeField(scope, scopeInfo),
          time: {
            created: entry.createdAt ?? entryUpdatedAt(entry),
            updated: entryUpdatedAt(entry),
            ...(archived ? { archived } : {}),
          },
          pinned: entry.pinned || undefined,
          parentID: entry.parentID || undefined,
          lastExchange: info.lastExchange,
        },
      ]
    })

    return c.json({ data, total, offset, limit })
  },
)
