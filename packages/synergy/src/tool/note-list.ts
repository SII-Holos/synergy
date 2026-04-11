import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./note-list.txt"

const parameters = z.object({
  scope: z
    .enum(["current", "global", "all"])
    .default("all")
    .describe("Which scope to list from: 'current' (project only), 'global' (global only), 'all' (both)."),
  since: z
    .string()
    .optional()
    .describe(
      "Only include notes updated on or after this date (ISO 8601, e.g. '2026-03-15' or '2026-03-15T18:00:00').",
    ),
  before: z.string().optional().describe("Only include notes updated before this date (ISO 8601)."),
  offset: z.coerce.number().default(0).describe("Number of notes to skip."),
  limit: z.coerce.number().default(20).describe("Maximum number of notes to return (max 100)."),
})

export const NoteListTool = Tool.define("note_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const currentScopeID = Instance.scope.id

    let notes =
      params.scope === "all"
        ? await NoteStore.listMetaAll()
        : params.scope === "global"
          ? await NoteStore.listMeta("global")
          : await NoteStore.listMeta(currentScopeID)

    const sinceMs = params.since ? new Date(params.since).getTime() : undefined
    const beforeMs = params.before ? new Date(params.before).getTime() : undefined
    if (sinceMs || beforeMs) {
      notes = notes.filter((note) => {
        const t = note.time.updated
        if (sinceMs && t < sinceMs) return false
        if (beforeMs && t >= beforeMs) return false
        return true
      })
    }

    const total = notes.length
    const clampedLimit = Math.min(params.limit, 100)
    const page = notes.slice(params.offset, params.offset + clampedLimit)
    const shown = page.length

    if (total === 0) {
      return {
        title: "No notes found",
        output: "No notes found.",
        metadata: { count: 0, total: 0, scope: params.scope } as Record<string, any>,
      }
    }

    const lines = page.map((note) => {
      const parts: string[] = [`- [${note.id}] "${note.title}"`]
      if (note.pinned) parts.push("[pinned]")
      if (note.global) parts.push("[global]")
      if (note.tags.length > 0) parts.push(`— tags: ${note.tags.join(", ")}`)
      parts.push(`— updated ${new Date(note.time.updated).toISOString()}`)
      return parts.join(" ")
    })

    const rangeStart = params.offset + 1
    const rangeEnd = params.offset + shown
    const header = `Found ${total} note${total === 1 ? "" : "s"} (showing ${rangeStart}-${rangeEnd}):`

    const tagFreq = new Map<string, number>()
    for (const note of notes) {
      for (const tag of note.tags) {
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
      title: `${total} note${total === 1 ? "" : "s"}`,
      output: `${header}\n\n${lines.join("\n")}${tagSummary}`,
      metadata: { count: shown, total, scope: params.scope, tags: Object.fromEntries(tagFreq) } as Record<string, any>,
    }
  },
})
