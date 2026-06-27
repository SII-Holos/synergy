import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { NoteMarkdown } from "../note"
import { NoteDocument } from "../note"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./note-read.txt"

const MAX_IDS = 10
const MAX_LINES = 2000

const parameters = z.object({
  ids: z.array(z.string()).describe("List of note IDs to read (max 10)"),
  offset: z.coerce.number().optional().describe("Line or block offset to start reading from (0-based)"),
  limit: z.coerce.number().optional().describe("Maximum number of lines or blocks to return per note (max 2000)"),
  format: z
    .enum(["markdown", "blocks", "json"])
    .default("markdown")
    .describe(
      "Output format. 'markdown': content as markdown (default). 'blocks': editable block anchors for note_edit. 'json': structured note data.",
    ),
  detail: z
    .enum(["summary", "json"])
    .default("summary")
    .describe("Detail level for blocks/json output. Use 'json' when exact node JSON is needed for edits."),
  includeHashes: z.boolean().default(true).describe("Include docHash and block hashes for note_edit safety checks."),
})

function renderBlockInfo(
  block: NoteDocument.BlockInfo,
  index: number,
  includeHashes: boolean,
  includeJson: boolean,
): string {
  const parts = [`[block:${index}]`, `id=${block.id}`, `type=${block.type}`, `path=${block.pathLabel}`]
  if (includeHashes) parts.push(`hash=${block.hash}`)
  if (block.parentId) parts.push(`parent=${block.parentId}`)
  if (block.tableId) parts.push(`table=${block.tableId}`)
  if (block.row !== undefined) parts.push(`row=${block.row}`)
  if (block.col !== undefined) parts.push(`col=${block.col}`)
  const attrs = block.attrs && Object.keys(block.attrs).length > 0 ? `\n  attrs: ${JSON.stringify(block.attrs)}` : ""
  const text = block.text.trim() ? `\n  text: ${block.text}` : ""
  const json = includeJson ? `\n  json: ${JSON.stringify(block.json)}` : ""
  return `${parts.join(" ")}\n  summary: ${block.summary}${attrs}${text}${json}`
}

export const NoteReadTool = Tool.define("note_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const entries: string[] = []
    let found = 0
    const ids = params.ids.slice(0, MAX_IDS)

    const titles: string[] = []

    for (const id of ids) {
      try {
        const note = await NoteStore.getAny(ScopeContext.current.scope.id, id)
        found++
        titles.push(note.title)
        const doc = NoteDocument.normalize(note.content)
        const docHash = NoteDocument.hash(doc)
        const tags = note.tags.length > 0 ? note.tags.join(", ") : "none"
        const pinned = note.pinned ? "yes" : "no"
        const global = note.global ? "yes" : "no"
        const updated = formatLocalDateTime(note.time.updated)
        const kind = note.kind ?? "note"
        const blueprintLines =
          kind === "blueprint"
            ? [
                `Description: ${note.blueprint?.description ?? "none"}`,
                `Default Agent: ${note.blueprint?.defaultAgent ?? "none"}`,
                `Audit Agent: ${note.blueprint?.auditAgent ?? "supervisor"}`,
                `Active Loop: ${note.blueprint?.activeLoopID ?? "none"}`,
                `Run Count: ${note.blueprint?.runCount ?? 0}`,
                `Last Run: ${note.blueprint?.lastRunAt ? formatLocalDateTime(note.blueprint.lastRunAt) : "never"}`,
              ]
            : []

        const header = [
          `[${id}] ${note.title}`,
          `Kind: ${kind}`,
          ...blueprintLines,
          `Version: ${note.version}`,
          ...(params.includeHashes ? [`DocHash: ${docHash}`] : []),
          `Tags: ${tags}`,
          `Pinned: ${pinned} | Global: ${global}`,
          `Updated: ${updated}`,
          "",
          "---",
          "",
        ].join("\n")

        let body: string
        if (params.format === "json") {
          const blocks = NoteDocument.listBlocks(doc, { includeJson: params.detail === "json" })
          body = JSON.stringify(
            {
              id: note.id,
              title: note.title,
              kind,
              version: note.version,
              ...(params.includeHashes ? { docHash } : {}),
              tags: note.tags,
              pinned: note.pinned,
              global: note.global,
              blockCount: blocks.length,
              blocks,
              ...(params.detail === "json" ? { content: doc } : {}),
            },
            null,
            2,
          )
        } else if (params.format === "blocks") {
          const blocks = NoteDocument.listBlocks(doc, { includeJson: params.detail === "json" })
          const totalBlocks = blocks.length
          const offset = params.offset ?? 0
          const limit = Math.min(params.limit ?? totalBlocks, MAX_LINES)
          const sliced = blocks.slice(offset, offset + limit)
          body =
            [
              `BlockCount: ${totalBlocks}`,
              `ShowingBlocks: ${offset}-${offset + sliced.length - 1}`,
              "",
              sliced.length
                ? sliced
                    .map((block, index) =>
                      renderBlockInfo(block, offset + index, params.includeHashes, params.detail === "json"),
                    )
                    .join("\n")
                : "(empty note)",
            ].join("\n") +
            (sliced.length < totalBlocks
              ? `\n\n(showing blocks ${offset}-${offset + sliced.length - 1} of ${totalBlocks})`
              : "")
        } else {
          const bodyText = NoteMarkdown.toMarkdown(doc)
          const lines = bodyText.split("\n")
          const totalLines = lines.length
          const offset = params.offset ?? 0
          const limit = Math.min(params.limit ?? totalLines, MAX_LINES)
          const sliced = lines.slice(offset, offset + limit)
          const shown = sliced.length
          if (params.offset !== undefined || params.limit !== undefined) {
            const numbered = sliced.map(
              (line: string, i: number) => `${(offset + i + 1).toString().padStart(5)}\t${line}`,
            )
            body = numbered.join("\n")
            body += `\n\n(showing lines ${offset + 1}-${offset + shown} of ${totalLines})`
          } else {
            body = sliced.join("\n")
          }
        }

        entries.push(header + body)
      } catch {
        entries.push(`[${id}] Not found`)
      }
    }

    const titleLabel = titles.length === 1 ? titles[0] : `${found} notes`

    return {
      title: titleLabel,
      output: entries.join("\n\n===\n\n"),
      metadata: { count: found, titles } as Record<string, any>,
    }
  },
})
