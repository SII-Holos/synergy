import { fileURLToPath } from "url"
import fuzzysort from "fuzzysort"
import { ScopeContext } from "../scope/context"
import { Ripgrep } from "../file/ripgrep"
import { LSP } from "../lsp"
import { WorkspaceFile } from "./types"
import { WorkspaceFileIndexer } from "./indexer"
import { WorkspaceFileService } from "./service"
import { ProcessOutput } from "../process/output"

const DEFAULT_LIMIT = 50
const SEARCH_TIMEOUT_MS = 20_000
const MAX_CONTENT_LINE_LENGTH = 2000

function parseCursor(input: string | undefined) {
  return Math.max(0, Number.parseInt(input ?? "0", 10) || 0)
}

function normalizeList(input: string | string[] | undefined) {
  if (!input) return []
  const values = Array.isArray(input) ? input : input.split(",")
  return values.map((item) => item.trim()).filter(Boolean)
}

function resultIndices(result: unknown) {
  const indexes = (result as { indexes?: number[] }).indexes
  return Array.isArray(indexes) ? indexes : []
}

function compileGlobs(patterns: string[] | undefined) {
  return (patterns ?? []).flatMap((pattern) => {
    try {
      return [new Bun.Glob(pattern)]
    } catch {
      return []
    }
  })
}

async function withSearchAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Search aborted", "AbortError")
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Search aborted", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function searchFiles(input: {
  query: string
  limit: number
  cursor?: string
  include?: string[]
  exclude?: string[]
  signal?: AbortSignal
}): Promise<WorkspaceFile.SearchResponse> {
  const snapshot = await WorkspaceFileIndexer.snapshot({ signal: input.signal })
  const directories = snapshot.dirs.map((item) => (item.endsWith("/") ? item : item + "/"))
  const items = [...snapshot.files, ...directories]
  const include = compileGlobs(input.include)
  const exclude = compileGlobs(input.exclude)
  const filtered = items.filter((item) => {
    if (include.length && !include.some((pattern) => pattern.match(item))) return false
    if (exclude.length && exclude.some((pattern) => pattern.match(item))) return false
    return true
  })
  const offset = parseCursor(input.cursor)
  const searchLimit = offset + input.limit + 1
  const matches = input.query
    ? fuzzysort.go(input.query, filtered, { limit: searchLimit })
    : filtered.slice(0, searchLimit).map((target, index) => ({ target, score: -index }))
  const page = matches.slice(offset, offset + input.limit)
  const output = await Promise.all(
    page.map(async (match) => {
      const target = match.target
      const directory = target.endsWith("/")
      const path = directory ? target.slice(0, -1) : target
      const node = await WorkspaceFileService.maybeNode(path)
      return {
        kind: "file" as const,
        path,
        name: path.split("/").at(-1) ?? path,
        type: directory ? ("directory" as const) : ("file" as const),
        score: match.score,
        indices: resultIndices(match),
        node,
      }
    }),
  )

  return {
    kind: "files",
    query: input.query,
    items: output,
    nextCursor: offset + page.length < matches.length ? String(offset + page.length) : undefined,
    truncated: offset + page.length < matches.length,
  }
}

async function searchContent(input: {
  query: string
  limit: number
  cursor?: string
  include?: string[]
  exclude?: string[]
  signal?: AbortSignal
}): Promise<WorkspaceFile.SearchResponse> {
  if (!input.query.trim()) {
    return {
      kind: "content",
      query: input.query,
      items: [],
      truncated: false,
    }
  }

  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
    : AbortSignal.timeout(SEARCH_TIMEOUT_MS)

  const offset = parseCursor(input.cursor)
  const items: WorkspaceFile.ContentSearchItem[] = []
  let seen = 0
  let truncated = false
  try {
    for await (const data of Ripgrep.matches({
      cwd: ScopeContext.current.directory,
      pattern: input.query,
      glob: [...(input.include ?? []), ...(input.exclude ?? []).map((glob) => `!${glob}`)],
      fixedStrings: true,
      hidden: true,
      sortPath: true,
      signal,
    })) {
      if (seen++ < offset) continue
      const submatches: WorkspaceFile.ContentSearchItem["submatches"] = data.submatches.map((item) => ({
        text: item.match.text,
        start: item.start,
        end: item.end,
      }))
      const rawLine = data.lines.text.replace(/\r?\n$/, "")
      items.push({
        kind: "content",
        path: WorkspaceFileService.relative(data.path.text),
        lineNumber: data.line_number,
        column: submatches[0]?.start ?? 0,
        line: rawLine.length > MAX_CONTENT_LINE_LENGTH ? `${rawLine.slice(0, MAX_CONTENT_LINE_LENGTH)}...` : rawLine,
        score: 1,
        submatches,
        previewRanges: submatches.map((item) => ({ start: item.start, end: item.end })),
      })
      if (items.length > input.limit) {
        truncated = true
        break
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Search aborted", "AbortError")
    if (!(error instanceof ProcessOutput.LimitError) && !signal.aborted) throw error
    truncated = true
  }

  const page = items.slice(0, input.limit)
  const hasNextPage = items.length > input.limit || (truncated && page.length === input.limit)
  return {
    kind: "content",
    query: input.query,
    items: page,
    nextCursor: hasNextPage ? String(offset + input.limit) : undefined,
    truncated,
  }
}

async function searchSymbols(input: {
  query: string
  limit: number
  cursor?: string
  signal?: AbortSignal
}): Promise<WorkspaceFile.SearchResponse> {
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
    : AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const status = await withSearchAbort(LSP.status(), signal).catch(() => [])
  if (status.length === 0) {
    return {
      kind: "symbol",
      query: input.query,
      items: [],
      truncated: false,
      capability: {
        available: false,
        reason: "No active LSP clients. Open or touch a source file before running workspace symbol search.",
      },
    }
  }

  const symbols = await withSearchAbort(LSP.workspaceSymbol(input.query), signal).catch(() => [])
  const offset = parseCursor(input.cursor)
  const page = symbols.slice(offset, offset + input.limit + 1)
  const items = page.slice(0, input.limit).map((symbol): WorkspaceFile.SymbolSearchItem => {
    const absolute = fileURLToPath(symbol.location.uri)
    return {
      kind: "symbol",
      name: symbol.name,
      symbolKind: symbol.kind,
      path: WorkspaceFileService.relative(absolute),
      range: symbol.location.range,
      score: 1,
    }
  })

  return {
    kind: "symbol",
    query: input.query,
    items,
    nextCursor: page.length > input.limit ? String(offset + input.limit) : undefined,
    truncated: page.length > input.limit,
    capability: {
      available: true,
    },
  }
}

export namespace WorkspaceFileSearch {
  export async function search(input: {
    query: string
    kind: "files" | "content" | "symbol"
    limit?: number
    cursor?: string
    include?: string | string[]
    exclude?: string | string[]
    signal?: AbortSignal
  }): Promise<WorkspaceFile.SearchResponse> {
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 200))
    const include = normalizeList(input.include)
    const exclude = normalizeList(input.exclude)
    if (input.kind === "files") {
      return searchFiles({ query: input.query, limit, cursor: input.cursor, include, exclude, signal: input.signal })
    }
    if (input.kind === "content") {
      return searchContent({ query: input.query, limit, cursor: input.cursor, include, exclude, signal: input.signal })
    }
    return searchSymbols({ query: input.query, limit, cursor: input.cursor, signal: input.signal })
  }
}
