import * as path from "path"
import { withTimeout } from "@/util/timeout"
import { ToolTimeout } from "@/tool/timeout"

/** File size cap for document extraction. Larger files are rejected with a clear error. */
const MAX_FILE_BYTES = 50 * 1024 * 1024

/** Default extraction timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = ToolTimeout.DEFAULTS.documentExtractMs

/** Supported document extensions — markitdown-ts dispatches by extension. */
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".html",
  ".htm",
  ".epub",
  ".csv",
  ".xml",
  ".rss",
  ".atom",
  ".ipynb",
  ".jpg",
  ".jpeg",
  ".png",
  ".wav",
  ".mp3",
  ".zip",
])

interface MarkItDownResult {
  markdown?: string
  title?: string | null
}

interface MarkItDownConverter {
  convert(filepath: string): Promise<MarkItDownResult | null | undefined>
}

/** Singleton converter — jsdom/turndown/pdf-parse are expensive to re-instantiate. */
let _converter: MarkItDownConverter | undefined

function conversionEngineError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    `Document conversion engine could not start. Optional document parsing dependencies may be unavailable in this runtime. Cause: ${message}`,
    { cause: error },
  )
}

async function converter(): Promise<MarkItDownConverter> {
  if (_converter) return _converter
  try {
    const { MarkItDown } = await import("markitdown-ts")
    _converter = new MarkItDown()
    return _converter
  } catch (error) {
    throw conversionEngineError(error)
  }
}

export interface Extraction {
  /** Markdown text extracted from the document. */
  markdown: string
  /** Document title (null when markitdown-ts cannot determine one). */
  title: string | null
  /** Total line count (after normalizing line endings). */
  totalLines: number
  /** Total UTF-8 byte length of the extracted markdown. */
  totalBytes: number
}

export namespace Document {
  /**
   * Returns true when the file extension is a document format that
   * markitdown-ts can convert to markdown.
   */
  export function supported(filepath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filepath).toLowerCase())
  }

  /**
   * Extract document content as markdown with safety boundaries.
   *
   * Safety guarantees:
   * - Files > 50 MB are rejected before extraction starts.
   * - Extraction is capped at 60 s of wall-clock time.
   * - A null return means the converter could not handle the file
   *   (corrupted, password-protected, or truly unsupported data within a
   *   supported extension).
   *
   * Throws on:
   * - Missing file / system errors (propagated from Bun).
   * - Files exceeding the size limit.
   * - Extraction timeout.
   */
  export async function extract(filepath: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Extraction | null> {
    const stat = await Bun.file(filepath).stat()
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `Document too large for text extraction: ${(stat.size / (1024 * 1024)).toFixed(1)} MB. ` +
          `The maximum supported size is ${MAX_FILE_BYTES / (1024 * 1024)} MB. ` +
          `Open the file in a native application or convert to a smaller format.`,
      )
    }

    const engine = await converter()
    const result = await withTimeout(engine.convert(filepath), timeoutMs)

    if (!result) return null

    const markdown = result.markdown?.trim() || ""

    return {
      markdown,
      title: result.title ?? null,
      totalLines: markdown === "" ? 0 : markdown.split("\n").length,
      totalBytes: Buffer.byteLength(markdown, "utf-8"),
    }
  }

  /**
   * Legacy compatibility shim — returns the plain markdown string.
   * Kept for backward compat with `Attachment.extractTextFromFile`.
   */
  export async function extractText(filepath: string): Promise<string> {
    const extraction = await extract(filepath)
    if (!extraction) {
      throw new Error(
        `Could not extract text from ${path.basename(filepath)}. ` +
          `The file may be corrupted, password-protected, or in an unsupported format.`,
      )
    }
    return extraction.markdown
  }
}
