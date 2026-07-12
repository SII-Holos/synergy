import path from "node:path"
import z from "zod"
import { Tool } from "./tool"
import { SessionNav } from "../session/nav"
import { ScopeContext } from "../scope/context"
import { formatLocalDateTime } from "@/util/time-format"
import DESCRIPTION from "./scope-list.txt"

const parameters = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional case-insensitive filter matched against scope id, name, and directory."),
  includeHome: z.boolean().optional().default(true).describe("Whether to include the home scope. Defaults to true."),
  limit: z.coerce.number().default(50).describe("Maximum number of scopes to return (max 100)."),
  offset: z.coerce.number().default(0).describe("Number of scopes to skip for pagination."),
})

interface ScopeListEntry {
  id: string
  type: "home" | "project"
  name?: string
  directory: string
  sessionCount: number
  latestActivityAt: number
  icon?: { url?: string; color?: string }
  current: boolean
}

function matchesQuery(entry: ScopeListEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystacks = [entry.id, entry.name ?? "", entry.directory, path.basename(entry.directory)]
  return haystacks.some((value) => value.toLowerCase().includes(needle))
}

function formatEntry(entry: ScopeListEntry): string {
  const label =
    entry.type === "home"
      ? "Home"
      : (entry.name ?? (entry.directory ? path.basename(entry.directory) : undefined) ?? entry.id)
  const parts = [`- [${entry.id}] ${label} (${entry.type})`]
  if (entry.current) parts.push("[current]")
  if (entry.directory) parts.push(`— ${entry.directory}`)
  parts.push(`— ${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"}`)
  if (entry.latestActivityAt > 0) {
    parts.push(`— last activity ${formatLocalDateTime(entry.latestActivityAt)}`)
  }
  return parts.join(" ")
}

export const ScopeListTool = Tool.define("scope_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const currentScopeID = ScopeContext.current.scope.id
    const index = await SessionNav.buildScopeIndex()
    let entries: ScopeListEntry[] = index.map((item) => ({
      id: item.scopeID,
      type: item.scopeType,
      name: item.name,
      directory: item.directory,
      sessionCount: item.sessionCount,
      latestActivityAt: item.latestActivityAt,
      icon: item.icon,
      current: item.scopeID === currentScopeID,
    }))

    entries.sort((a, b) => {
      // Keep the active scope discoverable even when many historical scopes exist.
      if (a.current !== b.current) return a.current ? -1 : 1
      if ((a.id === "home") !== (b.id === "home")) return a.id === "home" ? -1 : 1
      return b.latestActivityAt - a.latestActivityAt || a.id.localeCompare(b.id)
    })

    if (!params.includeHome) {
      entries = entries.filter((entry) => entry.type !== "home")
    }
    if (params.query?.trim()) {
      entries = entries.filter((entry) => matchesQuery(entry, params.query!))
    }

    const total = entries.length
    const clampedLimit = Math.min(Math.max(params.limit, 0), 100)
    const offset = Math.max(params.offset, 0)
    const page = entries.slice(offset, offset + clampedLimit)
    const shown = page.length

    if (total === 0) {
      return {
        title: "No scopes found",
        output: params.query?.trim() ? `No scopes matched query "${params.query.trim()}".` : "No scopes found.",
        metadata: {
          count: 0,
          total: 0,
          offset,
          query: params.query,
          includeHome: params.includeHome,
          currentScopeID,
          scopes: [],
        } as Record<string, any>,
      }
    }

    const rangeStart = offset + 1
    const rangeEnd = offset + shown
    const header = `Found ${total} scope${total === 1 ? "" : "s"} (showing ${rangeStart}-${rangeEnd}). Use id with session_control create as scopeID.`
    const lines = page.map(formatEntry)

    return {
      title: `${total} scope${total === 1 ? "" : "s"}`,
      output: `${header}\n\n${lines.join("\n")}`,
      metadata: {
        count: shown,
        total,
        offset,
        query: params.query,
        includeHome: params.includeHome,
        currentScopeID,
        scopes: page,
      } as Record<string, any>,
    }
  },
})
