import z from "zod"
import path from "path"
import { randomUUID } from "node:crypto"
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises"
import { Tool } from "./tool"
import { Flag } from "../flag/flag"
import { ScopeContext } from "../scope/context"
import { ToolTimeout } from "./timeout"
import { SearchGuard } from "./search-guard"

const DEFAULT_TIMEOUT = ToolTimeout.DEFAULTS.arxivSearchMs
const ARXIV_PDF_BASE = "https://arxiv.org/pdf"
const ARXIV_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

class ArxivDownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Failed to download paper: HTTP ${status}`)
    this.name = "ArxivDownloadHttpError"
  }
}

export async function downloadArxivPdf(input: {
  url: string
  filepath: string
  signal: AbortSignal
  timeoutMs: number
  maxBytes: number
}) {
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort(new DOMException("Download timed out", "TimeoutError"))
  }, input.timeoutMs)
  if (typeof timer === "object" && "unref" in timer) timer.unref()

  const signal = AbortSignal.any([input.signal, timeout.signal])
  const tempPath = path.join(path.dirname(input.filepath), `.synergy-arxiv-${process.pid}-${randomUUID()}.tmp`)
  let file: FileHandle | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let complete = false
  let committed = false
  let size = 0
  let failure: unknown

  const cancelReader = () => {
    if (!reader) return
    void reader.cancel(signal.reason).catch(() => {})
  }

  try {
    const response = await fetch(input.url, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Synergy/1.0)",
      },
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ArxivDownloadHttpError(response.status)
    }
    if (!response.body) throw new Error("Failed to download paper: response body is empty")

    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > input.maxBytes) {
      await response.body.cancel().catch(() => {})
      throw new Error(`Download exceeds the ${input.maxBytes}-byte limit`)
    }

    reader = response.body.getReader()
    signal.addEventListener("abort", cancelReader, { once: true })
    if (signal.aborted) signal.throwIfAborted()
    file = await open(tempPath, "wx", 0o600)
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        complete = true
        break
      }

      size += chunk.value.byteLength
      if (size > input.maxBytes) {
        throw new Error(`Download exceeds the ${input.maxBytes}-byte limit`)
      }

      let offset = 0
      while (offset < chunk.value.byteLength) {
        const result = await file.write(chunk.value, offset, chunk.value.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error("Failed to write downloaded paper")
        offset += result.bytesWritten
      }
    }
    const destination = await lstat(input.filepath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (destination?.isSymbolicLink()) throw new Error("Output path must not be a symbolic link")
    if (destination && (!destination.isFile() || destination.nlink > 1)) {
      throw new Error("Output path must be a regular file with a single hard link")
    }
    await file.chmod(destination ? destination.mode & 0o777 : 0o666 & ~process.umask())
    signal.throwIfAborted()
    await file.sync()
    signal.throwIfAborted()
    await file.close()
    file = undefined
    signal.throwIfAborted()
    await rename(tempPath, input.filepath)
    committed = true
  } catch (error) {
    failure = timedOut
      ? new Error("Download timed out", { cause: error })
      : input.signal.aborted
        ? (input.signal.reason ?? error)
        : error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancelReader)
    const cleanupErrors: unknown[] = []
    if (reader) {
      if (!complete) await reader.cancel().catch((error) => cleanupErrors.push(error))
      try {
        reader.releaseLock()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await file?.close().catch((error) => cleanupErrors.push(error))
    if (!committed) await rm(tempPath, { force: true }).catch((error) => cleanupErrors.push(error))
    if (!committed && cleanupErrors.length) {
      const cleanupFailure =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Multiple arXiv download cleanup operations failed.")
      failure = failure
        ? new AggregateError([failure, cleanupFailure], "The arXiv download and its cleanup both failed.")
        : cleanupFailure
    }
  }

  if (failure) throw failure
  return size
}

interface Paper {
  id: string
  title: string
  authors: string[]
  categories: string[]
  published_date: string
  summary: string
  pdf_url: string
  arxiv_url: string
  score?: number
}

interface SearchResponse {
  papers: Paper[]
  total: number
  query?: string
  mode: string
  reranked: boolean
}

export const ArxivSearchTool = Tool.define("arxiv_search", {
  description: `Search the arXiv database for academic papers using semantic search and filters.

Use this tool to find research papers on arXiv. You can search using:
- Natural language queries for semantic search
- Author names (OR logic between multiple authors)
- arXiv categories like 'cs.AI', 'hep-ph', 'math.AG' (OR logic)
- Date ranges (YYYY-MM-DD format)
- Title keywords (AND logic between keywords)

Returns paper metadata including title, authors, abstract, categories, and arXiv ID.`,
  parameters: z.object({
    query: z.string().optional().describe("Natural language search query for semantic search"),
    authors: z.array(z.string()).optional().describe("Filter by author names (OR logic)"),
    categories: z.array(z.string()).optional().describe("Filter by arXiv categories like 'cs.AI', 'hep-ph' (OR logic)"),
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD, inclusive)"),
    endDate: z.string().optional().describe("End date (YYYY-MM-DD, inclusive)"),
    titleKeywords: z.array(z.string()).optional().describe("Keywords in title (AND logic)"),
    topK: z.coerce.number().default(10).describe("Number of results (1-100, default: 10)"),
  }),
  async execute(params, ctx) {
    const searchScope = String((ctx.extra as any)?.userMessageID ?? ctx.sessionID)
    const duplicate = SearchGuard.checkDuplicate(searchScope, "arxiv_search", params)
    if (duplicate) {
      return {
        title: "arXiv search skipped",
        output: duplicate.output,
        metadata: {
          total: 0,
          shown: 0,
          searchFailureType: "duplicate_query" as const,
          query: duplicate.query,
        } as any,
      }
    }

    await ctx.ask({
      permission: "arxiv_search",
      patterns: ["*"],
      metadata: {},
    })
    SearchGuard.recordAttempt(searchScope, "arxiv_search", params)

    const url = `${Flag.SYNERGY_ARXIV_API_URL}/search`
    const body = {
      query: params.query,
      authors: params.authors,
      categories: params.categories,
      start_date: params.startDate,
      end_date: params.endDate,
      title_keywords: params.titleKeywords,
      top_k: Math.min(Math.max(params.topK, 1), 100),
      mode: "hybrid",
      rerank: true,
      include_summary: true,
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)

    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.any([controller.signal, ctx.abort]),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((error) => {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out")
      }
      throw error
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const failureType = SearchGuard.classifyHttpStatus(response.status) ?? "blocked_or_unavailable"
      throw new Error(`arXiv search failed with status: ${response.status} (${failureType})`)
    }

    const data = (await response.json()) as SearchResponse
    const papers = data.papers

    if (papers.length === 0) {
      return {
        title: "No results found",
        output: [
          "No papers found matching your search criteria.",
          "",
          `[Search failure: no_results] ${SearchGuard.advice("no_results")}`,
        ].join("\n"),
        metadata: {
          total: 0,
          shown: 0,
          searchFailureType: "no_results" as const,
          query: SearchGuard.extractQuery("arxiv_search", params),
        } as any,
      }
    }

    const lines = [
      `Found ${data.total} papers (showing ${papers.length}):`,
      "",
      "| # | arXiv ID | Title | Authors | Categories | Published |",
      "|---|----------|-------|---------|------------|-----------|",
    ]

    for (let i = 0; i < papers.length; i++) {
      const paper = papers[i]
      const title = paper.title.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 60)
      const authors = paper.authors.slice(0, 3).join(", ") + (paper.authors.length > 3 ? " et al." : "")
      const categories = paper.categories.slice(0, 2).join(", ")
      const published = paper.published_date.slice(0, 10)
      lines.push(`| ${i + 1} | ${paper.id} | ${title} | ${authors} | ${categories} | ${published} |`)
    }

    lines.push("")
    lines.push("**Paper Details:**")
    lines.push("")

    for (const paper of papers) {
      lines.push(`### ${paper.id}: ${paper.title}`)
      lines.push(`**Authors:** ${paper.authors.join(", ")}`)
      lines.push(`**Categories:** ${paper.categories.join(", ")}`)
      lines.push(`**Published:** ${paper.published_date}`)
      lines.push(`**PDF:** ${paper.pdf_url}`)
      lines.push("")
      lines.push(`**Abstract:** ${paper.summary}`)
      lines.push("")
      lines.push("---")
      lines.push("")
    }

    return {
      title: `${papers.length} papers found`,
      output: lines.join("\n"),
      metadata: {
        total: data.total,
        shown: papers.length,
      },
    }
  },
})

export const ArxivDownloadTool = Tool.define("arxiv_download", {
  description: `Download an arXiv paper as a PDF file.

Use this tool to download a paper from arXiv given its ID. The paper will be saved as a PDF file to the specified path.

Examples of valid arXiv IDs:
- 2401.12345
- 2401.12345v1
- hep-th/9901001`,
  parameters: z.object({
    arxivId: z.string().describe("The arXiv paper ID (e.g., '2401.12345' or '2401.12345v1')"),
    outputPath: z.string().describe("The output file path (must end with .pdf)"),
    overwrite: z.boolean().default(false).describe("Whether to overwrite if file exists"),
  }),
  async execute(params, ctx) {
    if (!params.outputPath.toLowerCase().endsWith(".pdf")) {
      throw new Error("Output path must end with .pdf")
    }

    const filepath = path.isAbsolute(params.outputPath)
      ? params.outputPath
      : path.join(ScopeContext.current.directory, params.outputPath)

    const file = Bun.file(filepath)
    const exists = await file.exists()

    if (exists && !params.overwrite) {
      return {
        title: "File exists",
        output: `File already exists at ${filepath}. Set overwrite=true to replace it.`,
        metadata: { filepath, arxivId: params.arxivId, size: 0, downloaded: false },
      }
    }

    const displayPath = path.relative(ScopeContext.current.directory, filepath)

    await ctx.ask({
      permission: "download",
      patterns: [displayPath],
      metadata: {
        arxivId: params.arxivId,
        filepath,
      },
    })

    const url = `${ARXIV_PDF_BASE}/${params.arxivId}.pdf`
    const size = await downloadArxivPdf({
      url,
      filepath,
      signal: ctx.abort,
      timeoutMs: ToolTimeout.DEFAULTS.arxivDownloadMs,
      maxBytes: ARXIV_DOWNLOAD_MAX_BYTES,
    }).catch((error) => {
      if (error instanceof ArxivDownloadHttpError) {
        const failureType = SearchGuard.classifyHttpStatus(error.status) ?? "blocked_or_unavailable"
        throw new Error(`Failed to download paper: HTTP ${error.status} (${failureType})`)
      }
      throw error
    })

    const sizeStr = size > 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MB` : `${(size / 1024).toFixed(2)} KB`

    return {
      title: `Downloaded ${params.arxivId}`,
      output: `Successfully downloaded arXiv paper ${params.arxivId} to ${filepath} (${sizeStr})`,
      metadata: {
        filepath,
        arxivId: params.arxivId,
        size,
        downloaded: true,
      },
    }
  },
})
