import { FileAttachment } from "../file/attachment"
import { FileView } from "../file/view"
import { FileMutation } from "../file/mutation"
import z from "zod"
import * as path from "path"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolLspSource } from "@ericsanchezok/synergy-harness/tool/lsp-source"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import DESCRIPTION from "./read.txt"
import { OutputBudget } from "./anchored-file"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"

const DEFAULT_READ_LIMIT = 2000
const MAX_BYTES = 50 * 1024

export const ReadTool = Tool.define(
  "read",
  {
    description: DESCRIPTION,
    parameters: z.object({
      filePath: z.string().describe("The path to the file to read"),
      offset: z.coerce.number().int().min(0).describe("The line number to start reading from (0-based)").optional(),
      limit: z.coerce
        .number()
        .int()
        .min(0)
        .describe("The maximum number of lines to read (defaults to 2000)")
        .optional(),
    }),
    async execute(params, ctx) {
      const filepath = FileView.resolve(params.filePath)
      const title = FileView.display(filepath)

      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        metadata: {},
      })

      const file = FileView.file(filepath)
      if (!(await file.exists())) {
        const dir = path.dirname(filepath)
        const base = path.basename(filepath)

        const dirEntries = (await FileView.list(dir === "." ? "" : dir)).map((entry) => path.basename(entry.path))
        const suggestions = dirEntries
          .filter(
            (entry) =>
              entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
          )
          .map((entry) => path.join(dir, entry))
          .slice(0, 3)

        if (suggestions.length > 0) {
          throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
        }

        throw new Error(`File not found: ${filepath}`)
      }

      const filePolicy = Attachment.policy({ filepath, mime: file.type })
      if (filePolicy.extractText) {
        const text = await FileAttachment.extractText(filepath, file.type)
        const lines = text.split("\n")
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 0

        const raw: string[] = []
        const budget = new OutputBudget(MAX_BYTES)
        let truncatedByBytes = false
        for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
          const line = lines[i]
          if (!budget.take(`${(i + 1).toString().padStart(5, "0")}| ${line}`)) {
            truncatedByBytes = true
            break
          }
          raw.push(line)
        }

        const content = raw.map((line, index) => {
          return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
        })
        const preview = raw.slice(0, 20).join("\n")

        const totalLines = lines.length
        const lastReadLine = offset + raw.length
        const hasMoreLines = totalLines > lastReadLine
        const truncated = hasMoreLines || truncatedByBytes

        let output = "<file>\n"
        output += content.join("\n")
        if (truncatedByBytes && raw.length === 0)
          output += `\nLine ${offset + 1} exceeds the output budget. Inspect it with a bounded shell command; repeating this offset cannot reveal the full line.`
        if (truncatedByBytes && raw.length > 0) {
          output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use offset=${lastReadLine} to continue)`
        } else if (hasMoreLines && !truncatedByBytes) {
          output += `\n\n(Document has more lines. Use offset=${lastReadLine} to continue)`
        } else if (!truncatedByBytes) {
          output += `\n\n(End of document - total ${totalLines} lines)`
        }
        output += "\n</file>"

        const attachments = filePolicy.keepBinary
          ? [
              await FileAttachment.toPart({
                filepath,
                mime: "application/pdf",
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
              }),
            ]
          : undefined

        return {
          title,
          activityEvidence: await ctx.recordActivity?.({
            kind: "file-read",
            resource: {
              path: filepath,
              workspaceID: ctx.resources?.workspace?.id,
              generation: ctx.resources?.workspace?.binding.generation,
            },
            range: { startLine: offset, lineCount: raw.length, totalLines },
            text: raw.join("\n"),
            truncated,
            mediaType: "text/plain",
          }),
          output,
          metadata: {
            preview,
            truncated,
            offset,
            limit,
          },
          attachments,
        }
      }

      const isBinary = await isBinaryFile(filepath, file)
      if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const offset = params.offset ?? 0
      const rawContent = await FileMutation.readText(filepath)
      const lines = rawContent.split("\n")

      const raw: string[] = []
      const budget = new OutputBudget(MAX_BYTES)
      let truncatedByBytes = false
      for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
        const line = lines[i]
        if (!budget.take(`${(i + 1).toString().padStart(5, "0")}| ${line}`)) {
          truncatedByBytes = true
          break
        }
        raw.push(line)
      }

      const content = raw.map((line, index) => {
        return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
      })
      const preview = raw.slice(0, 20).join("\n")

      let output = "<file>\n"
      output += content.join("\n")
      if (truncatedByBytes && raw.length === 0)
        output += `\nLine ${offset + 1} exceeds the output budget. Inspect it with a bounded shell command; repeating this offset cannot reveal the full line.`

      const totalLines = lines.length
      const lastReadLine = offset + raw.length
      const hasMoreLines = totalLines > lastReadLine
      const truncated = hasMoreLines || truncatedByBytes

      if (truncatedByBytes && raw.length > 0) {
        output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use offset=${lastReadLine} to continue)`
      } else if (hasMoreLines && !truncatedByBytes) {
        output += `\n\n(File has more lines. Use offset=${lastReadLine} to continue)`
      } else if (!truncatedByBytes) {
        output += `\n\n(End of file - total ${totalLines} lines)`
      }
      output += "\n</file>"

      // just warms the lsp client
      void ToolLspSource.get()?.touchFile(filepath, false)
      FileTime.read(ctx.sessionID, filepath, rawContent)

      return {
        title,
        activityEvidence: await ctx.recordActivity?.({
          kind: "file-read",
          resource: {
            path: filepath,
            workspaceID: ctx.resources?.workspace?.id,
            generation: ctx.resources?.workspace?.binding.generation,
          },
          range: { startLine: offset, lineCount: raw.length, totalLines },
          text: raw.join("\n"),
          truncated,
          mediaType: /\.md$/i.test(filepath) ? "text/markdown" : "text/plain",
        }),
        output,
        metadata: {
          preview,
          truncated,
          offset,
          limit,
        },
      }
    },
  },
  { requiresWorkspace: true },
)

async function isBinaryFile(filepath: string, file: ReturnType<typeof FileView.file>): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".xls":
    case ".ppt":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.slice(0, bufferSize).arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
