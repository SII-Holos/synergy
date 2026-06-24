import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { NoteMarkdown } from "../note"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./note-read.txt"

const MAX_IDS = 10
const MAX_LINES = 2000

const parameters = z.object({
  ids: z.array(z.string()).describe("List of note IDs to read (max 10)"),
  offset: z.coerce.number().optional().describe("Line offset to start reading from (0-based)"),
  limit: z.coerce.number().optional().describe("Maximum number of lines to return per note (max 2000)"),
  format: z
    .enum(["markdown", "blocks"])
    .default("markdown")
    .describe(
      "Output format. 'markdown': content as markdown (default). 'blocks': flattened numbered block list for use with note_edit block-index API.",
    ),
})

type TipTapNode = {
  type: string
  attrs?: Record<string, any>
  content?: TipTapNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
}

function renderBlocks(doc: any): string {
  const blocks = doc?.content ?? []
  if (blocks.length === 0) return "(empty note)"

  return blocks
    .map((node: TipTapNode, i: number) => {
      const header = `[block:${i}]`
      const text = renderBlock(node)
      return `${header} ${text}`
    })
    .join("\n")
}

function renderBlock(node: TipTapNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? [])
    case "heading":
      return "#".repeat(node.attrs?.level ?? 1) + " " + renderInline(node.content ?? [])
    case "bulletList":
      return (node.content ?? [])
        .map((item) => "- " + renderInline((item.content ?? []).flatMap((b) => b.content ?? [])))
        .join("\n  ")
    case "orderedList":
      return (node.content ?? [])
        .map((item, i) => `${i + 1}. ` + renderInline((item.content ?? []).flatMap((b) => b.content ?? [])))
        .join("\n  ")
    case "taskList":
      return (node.content ?? [])
        .map((item) => {
          const checked = item.attrs?.checked ? "x" : " "
          return `- [${checked}] ` + renderInline((item.content ?? []).flatMap((b) => b.content ?? []))
        })
        .join("\n  ")
    case "codeBlock": {
      const lang = node.attrs?.language ?? ""
      const code = (node.content ?? []).map((t) => t.text ?? "").join("")
      return "```" + lang + "\n" + code + "\n```"
    }
    case "blockquote":
      return renderInline(node.content ?? [])
    case "horizontalRule":
      return "---"
    case "mermaid":
    case "mermaidDiagram":
      return "[Mermaid diagram]"
    case "video":
      return "[Video: " + (node.attrs?.src ?? "unknown") + "]"
    case "image":
      return "[Image: " + (node.attrs?.src ?? node.attrs?.alt ?? "unknown") + "]"
    case "table":
      return "[Table: " + ((node.content ?? []).length || 0) + " rows]"
    default:
      return renderInline(node.content ?? []) || "[Unknown block: " + node.type + "]"
  }
}

function renderInline(content: TipTapNode[]): string {
  if (!content || content.length === 0) return ""
  return content
    .map((node) => {
      if (node.type === "text") {
        let text = node.text ?? ""
        if (node.marks) {
          for (const mark of node.marks) {
            switch (mark.type) {
              case "bold":
                text = "**" + text + "**"
                break
              case "italic":
                text = "*" + text + "*"
                break
              case "code":
                text = "`" + text + "`"
                break
              case "strike":
                text = "~~" + text + "~~"
                break
              case "link":
                text = "[" + text + "](" + (mark.attrs?.href ?? "") + ")"
                break
            }
          }
        }
        return text
      }
      if (node.type === "hardBreak") return "\n"
      if (node.type === "inlineMath" || node.type === "mathInline") {
        return node.attrs?.latex ? "$" + node.attrs.latex + "$" : ""
      }
      if (node.type === "image") {
        return "[Image: " + (node.attrs?.src ?? "unknown") + "]"
      }
      return ""
    })
    .join("")
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
        const bodyText = params.format === "blocks" ? renderBlocks(note.content) : NoteMarkdown.toMarkdown(note.content)
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
                `Active Loop: ${note.blueprint?.activeLoopID ?? "none"}`,
                `Run Count: ${note.blueprint?.runCount ?? 0}`,
                `Last Run: ${note.blueprint?.lastRunAt ? formatLocalDateTime(note.blueprint.lastRunAt) : "never"}`,
              ]
            : []

        const header = [
          `[${id}] ${note.title}`,
          `Kind: ${kind}`,
          ...blueprintLines,
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
        if (params.format === "blocks") {
          body = sliced.join("\n")
        } else if (params.offset !== undefined || params.limit !== undefined) {
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

    const titleLabel = titles.length === 1 ? titles[0] : `${found} notes`

    return {
      title: titleLabel,
      output: entries.join("\n\n===\n\n"),
      metadata: { count: found, titles } as Record<string, any>,
    }
  },
})
