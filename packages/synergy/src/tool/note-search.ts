import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./note-search.txt"

const parameters = z.object({
  pattern: z.string().describe("Regex pattern to search for in note titles and content."),
  scope: z
    .enum(["current", "global", "all"])
    .default("all")
    .describe("Which scope to search: 'current', 'global', or 'all'."),
  since: z
    .string()
    .optional()
    .describe(
      "Only include notes updated on or after this date (ISO 8601, e.g. '2026-03-15' or '2026-03-15T18:00:00').",
    ),
  before: z.string().optional().describe("Only include notes updated before this date (ISO 8601)."),
  tags: z.array(z.string()).optional().describe("Only search notes that have ALL of these tags."),
  pinned: z.boolean().optional().describe("Filter by pinned status."),
})

const MAX_NOTES = 10
const MAX_MATCHES = 20
const CONTEXT_LINES = 1

interface MatchRange {
  start: number
  end: number
}

function mergeRanges(ranges: MatchRange[], totalLines: number): MatchRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: MatchRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = sorted[i]
    if (curr.start <= prev.end + 1) {
      prev.end = Math.min(Math.max(prev.end, curr.end), totalLines - 1)
    } else {
      merged.push(curr)
    }
  }
  return merged
}

export const NoteSearchTool = Tool.define("note_search", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    let regex: RegExp
    try {
      regex = new RegExp(params.pattern, "gi")
    } catch (err: any) {
      return {
        title: params.pattern,
        output: `Invalid regex pattern: ${err?.message ?? String(err)}`,
        metadata: { matchCount: 0, noteCount: 0, pattern: params.pattern } as Record<string, any>,
      }
    }

    const currentScopeID = Instance.scope.id
    const allNotes =
      params.scope === "all"
        ? await NoteStore.listMetaAll()
        : params.scope === "global"
          ? await NoteStore.listMeta("global")
          : await NoteStore.listMeta(currentScopeID)

    const sinceMs = params.since ? new Date(params.since).getTime() : undefined
    const beforeMs = params.before ? new Date(params.before).getTime() : undefined

    const filtered = allNotes.filter((note) => {
      if (sinceMs && note.time.updated < sinceMs) return false
      if (beforeMs && note.time.updated >= beforeMs) return false
      if (params.tags && params.tags.length > 0) {
        if (!params.tags.every((tag) => note.tags.includes(tag))) return false
      }
      if (params.pinned !== undefined && note.pinned !== params.pinned) return false
      return true
    })

    // Phase 1: pre-filter using contentText (cheap, no AST conversion)
    const candidates = filtered.filter((note) => {
      regex.lastIndex = 0
      if (regex.test(note.title)) return true
      regex.lastIndex = 0
      return regex.test(note.contentText)
    })

    // Phase 2: load full content only for matched notes, generate context lines
    const sections: string[] = []
    let totalMatches = 0
    let matchedNotes = 0

    for (const meta of candidates) {
      if (matchedNotes >= MAX_NOTES || totalMatches >= MAX_MATCHES) break

      const full = await NoteStore.getAny(currentScopeID, meta.id)
      const markdown = NoteMarkdown.toMarkdown(full.content)
      const lines = markdown.split("\n")

      regex.lastIndex = 0
      const titleMatch = regex.test(meta.title)

      const matchingLineIndices: number[] = []
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          matchingLineIndices.push(i)
        }
      }

      if (!titleMatch && matchingLineIndices.length === 0) continue

      matchedNotes++
      const contentMatchCount = Math.min(matchingLineIndices.length, MAX_MATCHES - totalMatches)
      totalMatches += contentMatchCount

      const header: string[] = [`[${meta.id}] "${meta.title}"`]
      if (meta.pinned) header.push("[pinned]")
      if (meta.global) header.push("[global]")

      const sectionLines: string[] = [header.join(" ")]

      if (matchingLineIndices.length === 0) {
        sectionLines.push("  (title match)")
      } else {
        const cappedIndices = matchingLineIndices.slice(0, contentMatchCount)
        const ranges: MatchRange[] = cappedIndices.map((idx) => ({
          start: Math.max(0, idx - CONTEXT_LINES),
          end: Math.min(lines.length - 1, idx + CONTEXT_LINES),
        }))
        const merged = mergeRanges(ranges, lines.length)

        for (const range of merged) {
          for (let i = range.start; i <= range.end; i++) {
            const lineNum = (i + 1).toString()
            sectionLines.push(`  ${lineNum}: ${lines[i]}`)
          }
        }
      }

      sections.push(sectionLines.join("\n"))
    }

    if (sections.length === 0) {
      return {
        title: params.pattern,
        output: "No notes match the pattern.",
        metadata: { matchCount: 0, noteCount: 0, pattern: params.pattern } as Record<string, any>,
      }
    }

    const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${matchedNotes} note${matchedNotes === 1 ? "" : "s"}:`
    const output = header + "\n\n" + sections.join("\n\n")

    return {
      title: params.pattern,
      output,
      metadata: { matchCount: totalMatches, noteCount: matchedNotes, pattern: params.pattern } as Record<string, any>,
    }
  },
})
