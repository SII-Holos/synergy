import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Flag } from "../flag/flag"
import { Instance } from "../scope/instance"
import { HolosRequest } from "@/holos/request"

const DEFAULT_TIMEOUT = 30 * 1000
const ARXIV_PDF_BASE = "https://arxiv.org/pdf"

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
    await ctx.ask({
      permission: "arxiv_search",
      patterns: ["*"],
      metadata: {},
    })

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

    const response = await HolosRequest.fetch(
      url,
      {
        method: "POST",
        signal: AbortSignal.any([controller.signal, ctx.abort]),
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { capability: "arxiv" },
    ).catch((error) => {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out")
      }
      throw error
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`arXiv search failed with status: ${response.status}`)
    }

    const data = (await response.json()) as SearchResponse
    const papers = data.papers

    if (papers.length === 0) {
      return {
        title: "No results found",
        output: "No papers found matching your search criteria.",
        metadata: { total: 0, shown: 0 },
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
      : path.join(Instance.directory, params.outputPath)

    const file = Bun.file(filepath)
    const exists = await file.exists()

    if (exists && !params.overwrite) {
      return {
        title: "File exists",
        output: `File already exists at ${filepath}. Set overwrite=true to replace it.`,
        metadata: { filepath, arxivId: params.arxivId, size: 0, downloaded: false },
      }
    }

    const displayPath = path.relative(Instance.directory, filepath)

    await ctx.ask({
      permission: "download",
      patterns: [displayPath],
      metadata: {
        arxivId: params.arxivId,
        filepath,
      },
    })

    const url = `${ARXIV_PDF_BASE}/${params.arxivId}.pdf`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60 * 1000)

    const response = await fetch(url, {
      signal: AbortSignal.any([controller.signal, ctx.abort]),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Synergy/1.0)",
      },
    }).catch((error) => {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Download timed out")
      }
      throw error
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Failed to download paper: HTTP ${response.status}`)
    }

    const buffer = await response.arrayBuffer()
    await Bun.write(filepath, buffer)

    const size = buffer.byteLength
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
