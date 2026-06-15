import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { Instance } from "../scope/instance"
import { Document } from "../util/document"
import { FileTime } from "../file/time"
import { truncateLineForDisplay } from "./anchored-file"
import DESCRIPTION from "./scan-document.txt"

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 2000
const MAX_OUTPUT_BYTES = 50 * 1024

const DOCUMENT_KINDS: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".html": "html",
  ".htm": "html",
  ".epub": "epub",
  ".ipynb": "ipynb",
  ".csv": "csv",
  ".xml": "xml",
  ".rss": "rss",
  ".atom": "atom",
  ".zip": "zip",
}

interface ScanDocumentMetadata {
  filePath: string
  documentKind: string
  title: string | null
  totalLines: number
  totalBytes: number
  offset: number
  limit: number
  returned: number
  truncated: boolean
  truncatedByBytes: boolean
}

export const ScanDocumentTool = Tool.define("scan_document", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("Absolute path to the document file"),
    offset: z.number().int().min(0).optional().describe("0-based line offset to start reading from (default 0)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Maximum lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)

    // Permission checks
    if (!ctx.extra?.["bypassCwdCheck"] && !Instance.contains(filepath)) {
      const parentDir = path.dirname(filepath)
      await ctx.ask({
        permission: "external_directory",
        patterns: [parentDir],
        metadata: { filepath, parentDir },
      })
    }

    await ctx.ask({
      permission: "scan_document",
      patterns: [filepath],
      metadata: {},
    })

    // Fast-path for unsupported formats before hitting the disk
    const ext = path.extname(filepath).toLowerCase()
    if (!Document.supported(filepath)) {
      const supported = "PDF, DOCX, XLSX, PPTX, HTML, EPUB, IPYNB, CSV, XML, RSS, Atom, images, audio, ZIP"
      throw new Error(
        `scan_document does not support "${ext}" files.\n` +
          `Supported formats: ${supported}.\n` +
          `For code files, use view_file. For image analysis, use look_at.`,
      )
    }

    // File existence
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filepath}`)
    }

    // Extraction with safety boundaries (timeout, size cap handled by Document.extract)
    let extraction: Awaited<ReturnType<typeof Document.extract>>
    try {
      extraction = await Document.extract(filepath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("timed out")) {
        throw new Error(
          `Document extraction timed out for ${path.basename(filepath)}. ` +
            `The file may be too large or complex. Try opening it in a native application.`,
        )
      }
      if (message.includes("too large")) {
        throw err // re-throw size-limit error verbatim
      }
      throw new Error(`Document extraction failed for ${path.basename(filepath)}: ${message}`)
    }

    if (!extraction) {
      throw new Error(
        `Could not extract text from ${path.basename(filepath)}. ` +
          `The file may be corrupted, password-protected, encrypted, or in a format variant that cannot be read.`,
      )
    }

    const documentKind = DOCUMENT_KINDS[ext] ?? "other"
    const offset = params.offset ?? 0
    const limit = params.limit ?? DEFAULT_LIMIT

    // Pagination: line window constrained by byte budget
    const allLines = extraction.markdown.split("\n")
    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false

    for (let i = offset; i < Math.min(allLines.length, offset + limit); i++) {
      const { text } = truncateLineForDisplay(allLines[i])
      const size = Buffer.byteLength(text, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_OUTPUT_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(text)
      bytes += size
    }

    // 1-based line numbers, consistent with read.ts and view_file
    const outputLines = raw.map((line, index) => `${offset + index + 1}:${line}`)
    let output = outputLines.join("\n")

    if (truncatedByBytes) {
      const nextOffset = offset + raw.length
      output += `\n\n(Output truncated at ${MAX_OUTPUT_BYTES} bytes. Use offset=${nextOffset} to continue.)`
    } else if (offset + raw.length < allLines.length) {
      const nextOffset = offset + raw.length
      output += `\n\n(Document has more lines. Use offset=${nextOffset} to continue.)`
    } else {
      output += `\n\n(End of document — ${allLines.length} lines total)`
    }

    FileTime.read(ctx.sessionID, filepath)

    const metadata: ScanDocumentMetadata = {
      filePath: filepath,
      documentKind,
      title: extraction.title,
      totalLines: allLines.length,
      totalBytes: extraction.totalBytes,
      offset,
      limit,
      returned: raw.length,
      truncated: truncatedByBytes || offset + raw.length < allLines.length,
      truncatedByBytes,
    }

    return {
      title: documentKind ? `${documentKind.toUpperCase()} Document` : "Document",
      output,
      metadata,
    }
  },
})
