import * as path from "path"
import { withTimeout } from "@/util/timeout"
import { ToolTimeout } from "@/tool/timeout"
import type { FileEntry } from "@zip.js/zip.js"

function extraction(markdown: string, title: string | null = null): Extraction {
  const normalized = markdown.trim()
  return {
    markdown: normalized,
    title,
    totalLines: normalized === "" ? 0 : normalized.split("\n").length,
    totalBytes: Buffer.byteLength(normalized, "utf-8"),
  }
}

const MAX_PPTX_SLIDES = 200
const MAX_PPTX_SLIDE_XML_BYTES = 10 * 1024 * 1024
const MAX_PPTX_TOTAL_XML_BYTES = 50 * 1024 * 1024

async function extractPptx(filepath: string): Promise<Extraction> {
  const { Uint8ArrayReader, ZipReader } = await import("@zip.js/zip.js")
  const bytes = await Bun.file(filepath).bytes()
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    const entries = await reader.getEntries()
    const slideEntries: { index: number; entry: FileEntry }[] = []
    let totalXmlBytes = 0
    for (const entry of entries) {
      if (entry.directory) continue
      const match = entry.filename.match(/^ppt\/slides\/slide(\d+)\.xml$/)
      if (!match) continue

      if (slideEntries.length >= MAX_PPTX_SLIDES) {
        throw new Error(`PPTX contains too many slides. The extraction limit is ${MAX_PPTX_SLIDES} slides.`)
      }
      if (entry.uncompressedSize > MAX_PPTX_SLIDE_XML_BYTES) {
        throw new Error(
          `PPTX slide entry exceeds the extraction limit: ${entry.filename} declares ${entry.uncompressedSize} bytes. ` +
            `The per-slide limit is ${MAX_PPTX_SLIDE_XML_BYTES} bytes.`,
        )
      }
      totalXmlBytes += entry.uncompressedSize
      if (totalXmlBytes > MAX_PPTX_TOTAL_XML_BYTES) {
        throw new Error(
          `PPTX slide content exceeds the extraction limit of ${MAX_PPTX_TOTAL_XML_BYTES} decompressed bytes.`,
        )
      }
      slideEntries.push({ index: Number.parseInt(match[1]), entry })
    }

    const decoder = new TextDecoder()
    const slides: { index: number; text: string }[] = []
    let extractedXmlBytes = 0
    for (const { entry, index } of slideEntries) {
      const chunks: Uint8Array[] = []
      let slideXmlBytes = 0
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            const nextSlideBytes = slideXmlBytes + chunk.byteLength
            if (nextSlideBytes > MAX_PPTX_SLIDE_XML_BYTES) {
              throw new Error(`PPTX slide entry exceeds the extraction limit while reading ${entry.filename}.`)
            }
            const nextTotalBytes = extractedXmlBytes + chunk.byteLength
            if (nextTotalBytes > MAX_PPTX_TOTAL_XML_BYTES) {
              throw new Error(
                `PPTX slide content exceeds the extraction limit of ${MAX_PPTX_TOTAL_XML_BYTES} decompressed bytes.`,
              )
            }
            slideXmlBytes = nextSlideBytes
            extractedXmlBytes = nextTotalBytes
            chunks.push(chunk.slice())
          },
        }),
      )
      const xmlBytes = new Uint8Array(slideXmlBytes)
      let offset = 0
      for (const chunk of chunks) {
        xmlBytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const xml = decoder.decode(xmlBytes)
      const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((item) => decodeXmlEntities(item[1]))
      if (texts.length > 0) slides.push({ index, text: texts.join(" ") })
    }
    slides.sort((a, b) => a.index - b.index)
    return extraction(slides.map((slide) => `[Slide ${slide.index}]\n${slide.text}`).join("\n\n"))
  } finally {
    await reader.close()
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

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
  /** Document title (null when the extractor cannot determine one). */
  title: string | null
  /** Total line count (after normalizing line endings). */
  totalLines: number
  /** Total UTF-8 byte length of the extracted markdown. */
  totalBytes: number
}

export namespace Document {
  /**
   * Returns true when the file extension has a built-in extractor or is
   * supported by the document conversion engine.
   */
  export function supported(filepath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filepath).toLowerCase())
  }

  /**
   * Extract document content as markdown with safety boundaries.
   *
   * Safety guarantees:
   * - Files > 50 MB are rejected before extraction starts.
   * - PPTX extraction rejects oversized slide entries, aggregate slide XML,
   *   and presentations with more than 200 slides before decompression.
   * - Extraction is capped at 60 s of wall-clock time.
   * - A null return means the generic conversion engine could not handle a
   *   non-PPTX file.
   *
   * Throws on:
   * - Missing file / system errors (propagated from Bun).
   * - Invalid or unsafe PPTX archives.
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

    if (path.extname(filepath).toLowerCase() === ".pptx") {
      return withTimeout(extractPptx(filepath), timeoutMs)
    }

    const engine = await converter()
    const result = await withTimeout(engine.convert(filepath), timeoutMs)
    if (!result) return null
    return extraction(result.markdown ?? "", result.title ?? null)
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
