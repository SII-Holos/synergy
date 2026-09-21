import z from "zod"
import { OutputBudget } from "./anchored-file"
import DESCRIPTION from "./file-search.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { WorkspaceFileSearch } from "../workspace-file/search"
import { WorkspaceFileIndexer } from "../workspace-file/indexer"
import type { WorkspaceFile } from "../workspace-file/types"

export const FileSearchTool = Tool.define("file_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Fuzzy filename, directory name, module name, path fragment, code symbol, or exact literal content snippet to search for",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum total merged results across path, content, and symbol matches; defaults to 50"),
    include: z
      .string()
      .optional()
      .describe("Optional comma-separated glob patterns to include for path and content search"),
    exclude: z
      .string()
      .optional()
      .describe("Optional comma-separated glob patterns to exclude from path and content search"),
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
      const candidates = result.items.filter((item) => item.kind === "file")
      const budget = new OutputBudget()
      const items = candidates.filter((item) =>
        budget.take(`${item.type === "directory" ? "dir " : "file"} ${item.path}`),
      )
      const listing = items.length
        ? items.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`).join("\n")
        : "No matching files found."

      return {
        title: params.query || "Files",
        output:
          result.truncated || items.length < candidates.length
            ? `${listing}\nResults limited; narrow the include filter to inspect remaining paths.`
            : listing,
        metadata: {
          query: params.query,
          pathCount: items.length,
          contentCount: 0,
          symbolCount: 0,
          count: items.length,
          displayedCounts: { path: items.length, content: 0, symbol: 0 },
          truncated: result.truncated || items.length < candidates.length,
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

    const groups = [
      pathItems.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`),
      contentItems.map(
        (item) =>
          `[content] ${item.path}:${item.lineNumber}:${item.column}: ${item.line.length > 2000 ? `${item.line.slice(0, 2000)}… [line shortened]` : item.line}`,
      ),
      symbolItems.map((item) => `[symbol] Symbol "${item.name}" in ${item.path}:${item.range.start.line + 1}`),
    ]
    const merged: string[] = []
    const displayedCounts = { path: 0, content: 0, symbol: 0 }
    const kinds = ["path", "content", "symbol"] as const
    const budget = new OutputBudget()
    const unique = new Set<string>()
    let budgetLimited = false
    for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index++) {
      for (let channel = 0; channel < groups.length; channel++) {
        const row = groups[channel][index]
        if (row === undefined || unique.has(row)) continue
        if (merged.length >= limit || !budget.take(row)) {
          budgetLimited = true
          continue
        }
        unique.add(row)
        merged.push(row)
        displayedCounts[kinds[channel]]++
      }
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
      output: budgetLimited
        ? `${output}\n[Results omitted by the shared budget. Narrow the query or scope for more evidence.]`
        : output,
      metadata: {
        query: params.query,
        pathCount: pathItems.length,
        contentCount: contentItems.length,
        symbolCount: symbolItems.length,
        count: merged.length,
        displayedCounts,
        truncated: budgetLimited || filesResult.truncated || contentTruncated || symbolTruncated,
        nextCursor: filesResult.nextCursor,
      },
    }
  },
})
