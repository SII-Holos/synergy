import z from "zod"
import DESCRIPTION from "./file-search.txt"
import { Tool } from "./tool"
import { WorkspaceFileSearch } from "../workspace-file/search"
import { WorkspaceFileIndexer } from "../workspace-file/indexer"
import type { WorkspaceFile } from "../workspace-file/types"

export const FileSearchTool = Tool.define("file_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Fuzzy filename, directory name, module name, path fragment, code symbol, or literal content snippet to search for",
      ),
    limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum total results across all search modes"),
    include: z.string().optional().describe("Optional comma-separated glob patterns to include"),
    exclude: z.string().optional().describe("Optional comma-separated glob patterns to exclude"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "file_search",
      patterns: [params.query || "*"],
      metadata: {
        query: params.query,
      },
    })

    const limit = params.limit ?? 50
    const query = params.query
    const signal = ctx.abort
    const include = params.include
    const exclude = params.exclude

    if (!query.trim()) {
      const result = await WorkspaceFileSearch.search({
        kind: "files",
        query,
        limit,
        include,
        exclude,
        signal,
      })
      const items = result.items.filter((item) => item.kind === "file")
      const output = items.length
        ? items.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`).join("\n")
        : "No matching files found."

      return {
        title: params.query || "Files",
        output,
        metadata: {
          query: params.query,
          pathCount: items.length,
          contentCount: 0,
          symbolCount: 0,
          count: items.length,
          truncated: result.truncated,
          nextCursor: result.nextCursor,
        },
      }
    }

    const contentSearch = () => WorkspaceFileSearch.search({ kind: "content", query, limit, include, exclude, signal })
    const symbolSearch = () => WorkspaceFileSearch.search({ kind: "symbol", query, limit, signal })

    let filesResult = await WorkspaceFileSearch.search({ kind: "files", query, limit, include, exclude, signal })
    let pathItems = filesResult.items.filter((item) => item.kind === "file")

    if (pathItems.length === 0) {
      await WorkspaceFileIndexer.snapshot({ force: true, signal })
      filesResult = await WorkspaceFileSearch.search({ kind: "files", query, limit, include, exclude, signal })
      pathItems = filesResult.items.filter((item) => item.kind === "file")
    }

    const [contentSettled, symbolSettled] = await Promise.allSettled([contentSearch(), symbolSearch()])

    const contentItems =
      contentSettled.status === "fulfilled"
        ? (contentSettled.value.items.filter((item) => item.kind === "content") as WorkspaceFile.ContentSearchItem[])
        : []
    const contentTruncated = contentSettled.status === "fulfilled" ? contentSettled.value.truncated : false
    const symbolItems =
      symbolSettled.status === "fulfilled"
        ? (symbolSettled.value.items.filter((item) => item.kind === "symbol") as WorkspaceFile.SymbolSearchItem[])
        : []
    const symbolTruncated = symbolSettled.status === "fulfilled" ? symbolSettled.value.truncated : false

    const merged: string[] = []
    let remaining = limit

    for (const item of pathItems.slice(0, remaining)) {
      if (item.kind !== "file") continue
      merged.push(`${item.type === "directory" ? "dir " : "file"} ${item.path}`)
    }
    remaining = limit - merged.length

    for (const item of contentItems.slice(0, remaining)) {
      merged.push(`[content] ${item.path}:${item.lineNumber}:${item.column}: ${item.line}`)
    }
    remaining = limit - merged.length

    for (const item of symbolItems.slice(0, remaining)) {
      const line = item.range.start.line + 1
      merged.push(`[symbol] Symbol "${item.name}" in ${item.path}:${line}`)
    }

    const output = merged.length
      ? merged.join("\n")
      : `No results found for "${query}".

Tips:
- Check for typos and try again
- Try a shorter query or partial filename
- For content searches, try fewer words
- New files may still be indexing — try searching again`

    return {
      title: params.query || "Search",
      output,
      metadata: {
        query: params.query,
        pathCount: pathItems.length,
        contentCount: contentItems.length,
        symbolCount: symbolItems.length,
        count: merged.length,
        truncated: filesResult.truncated || contentTruncated || symbolTruncated,
        nextCursor: filesResult.nextCursor,
      },
    }
  },
})
