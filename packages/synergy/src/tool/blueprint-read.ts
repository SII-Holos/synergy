import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { NoteStore, NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./blueprint-read.txt"

const MAX_IDS = 10
const MAX_LINES = 2000

const parameters = z.object({
  ids: z.array(z.string()).describe("List of blueprint note IDs to read (max 10)"),
  offset: z.coerce.number().optional().describe("Line offset to start reading from (0-based)"),
  limit: z.coerce.number().optional().describe("Maximum number of lines to return per blueprint (max 2000)"),
})

export const BlueprintReadTool = Tool.define("blueprint_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const entries: string[] = []
    let found = 0
    const ids = params.ids.slice(0, MAX_IDS)
    const titles: string[] = []

    for (const id of ids) {
      try {
        const note = await NoteStore.getAny(Instance.scope.id, id)
        found++
        titles.push(note.title)
        const bodyText = NoteMarkdown.toMarkdown(note.content)
        const tags = note.tags.length > 0 ? note.tags.join(", ") : "none"
        const pinned = note.pinned ? "yes" : "no"
        const global = note.global ? "yes" : "no"
        const updated = formatLocalDateTime(note.time.updated)
        const bp = note.blueprint
        const status = bp?.status ?? "draft"
        const description = bp?.description ?? "none"
        const defaultAgent = bp?.defaultAgent ?? "none"

        const header = [
          `[${id}] ${note.title}`,
          `Status: ${status}`,
          `Description: ${description}`,
          `Default Agent: ${defaultAgent}`,
          `Tags: ${tags}`,
          `Pinned: ${pinned} | Global: ${global}`,
          `Updated: ${updated}`,
          "",
          "---",
          "",
        ].join("\n")

        const lines = bodyText.split("\n")
        const totalLines = lines.length
        const offset = params.offset ?? 0
        const limit = Math.min(params.limit ?? totalLines, MAX_LINES)
        const sliced = lines.slice(offset, offset + limit)
        const shown = sliced.length

        let body: string
        if (params.offset !== undefined || params.limit !== undefined) {
          const numbered = sliced.map(
            (line: string, i: number) => `${(offset + i + 1).toString().padStart(5)}\t${line}`,
          )
          body = numbered.join("\n")
          body += `\n\n(showing lines ${offset + 1}-${offset + shown} of ${totalLines})`
        } else {
          body = sliced.join("\n")
        }

        entries.push(header + body)
      } catch {
        entries.push(`[${id}] Not found`)
      }
    }

    const titleLabel = titles.length === 1 ? titles[0] : `${found} blueprints`

    return {
      title: titleLabel,
      output: entries.join("\n\n===\n\n"),
      metadata: { count: found, titles } as Record<string, any>,
    }
  },
})
