import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./blueprint-list.txt"

const parameters = z.object({
  scope: z
    .enum(["current", "global", "all"])
    .default("all")
    .describe(
      "Which scope to list from: 'current' (project only), 'global' (global only), 'all' (current project + global).",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Only include blueprints updated on or after this date (ISO 8601, e.g. '2026-03-15' or '2026-03-15T18:00:00').",
    ),
  before: z.string().optional().describe("Only include blueprints updated before this date (ISO 8601)."),
  offset: z.coerce.number().default(0).describe("Number of blueprints to skip."),
  limit: z.coerce.number().default(20).describe("Maximum number of blueprints to return (max 100)."),
})

export const BlueprintListTool = Tool.define("blueprint_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const currentScopeID = Instance.scope.id

    let blueprints: NoteStore.Metadata[]
    if (params.scope === "all") {
      const [local, global] = await Promise.all([
        NoteStore.listByKind(currentScopeID, "blueprint"),
        NoteStore.listByKind("global", "blueprint"),
      ])
      const localMeta = local.map(toLightMeta)
      const globalMeta = global.map(toLightMeta)
      const merged = [...localMeta, ...globalMeta]
      merged.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.time.updated - a.time.updated
      })
      blueprints = merged
    } else if (params.scope === "global") {
      const notes = await NoteStore.listByKind("global", "blueprint")
      blueprints = notes.map(toLightMeta)
      blueprints.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.time.updated - a.time.updated
      })
    } else {
      const notes = await NoteStore.listByKind(currentScopeID, "blueprint")
      blueprints = notes.map(toLightMeta)
      blueprints.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.time.updated - a.time.updated
      })
    }

    const sinceMs = params.since ? new Date(params.since).getTime() : undefined
    const beforeMs = params.before ? new Date(params.before).getTime() : undefined
    if (sinceMs || beforeMs) {
      blueprints = blueprints.filter((bp) => {
        const t = bp.time.updated
        if (sinceMs && t < sinceMs) return false
        if (beforeMs && t >= beforeMs) return false
        return true
      })
    }

    const total = blueprints.length
    const clampedLimit = Math.min(params.limit, 100)
    const page = blueprints.slice(params.offset, params.offset + clampedLimit)
    const shown = page.length

    if (total === 0) {
      return {
        title: "No blueprints found",
        output: "No blueprints found.",
        metadata: { count: 0, total: 0, scope: params.scope } as Record<string, any>,
      }
    }

    const lines = page.map((bp) => {
      const parts: string[] = [`- [${bp.id}] "${bp.title}"`]
      if (bp.pinned) parts.push("[pinned]")
      if (bp.global) parts.push("[global]")
      if (bp.tags.length > 0) parts.push(`— tags: ${bp.tags.join(", ")}`)
      parts.push(`— updated ${formatLocalDateTime(bp.time.updated)}`)
      return parts.join(" ")
    })

    const rangeStart = params.offset + 1
    const rangeEnd = params.offset + shown
    const header = `Found ${total} blueprint${total === 1 ? "" : "s"} (showing ${rangeStart}-${rangeEnd}):`

    const tagFreq = new Map<string, number>()
    for (const bp of blueprints) {
      for (const tag of bp.tags) {
        tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1)
      }
    }
    const tagSummary =
      tagFreq.size > 0
        ? `\nTags: ${[...tagFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => `${tag}(${count})`)
            .join(", ")}`
        : ""

    return {
      title: `${total} blueprint${total === 1 ? "" : "s"}`,
      output: `${header}\n\n${lines.join("\n")}${tagSummary}`,
      metadata: { count: shown, total, scope: params.scope, tags: Object.fromEntries(tagFreq) } as Record<string, any>,
    }
  },
})

function toLightMeta(note: import("../note/types").NoteTypes.Info): NoteStore.Metadata {
  return {
    id: note.id,
    title: note.title,
    pinned: note.pinned,
    global: note.global,
    originScope: note.originScope,
    tags: note.tags,
    kind: note.kind,
    version: note.version,
    time: note.time,
    searchText: "",
  }
}
