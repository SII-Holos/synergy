import z from "zod"
import DESCRIPTION from "./file-search.txt"
import { Tool } from "./tool"
import { WorkspaceFileSearch } from "../workspace-file/search"

export const FileSearchTool = Tool.define("file_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Fuzzy filename, directory name, module name, or path fragment to search for"),
    limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum number of paths to return"),
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
    const result = await WorkspaceFileSearch.search({
      kind: "files",
      query: params.query,
      limit: params.limit ?? 50,
      include: params.include,
      exclude: params.exclude,
      signal: ctx.abort,
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
        results: items,
        count: items.length,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
      },
    }
  },
})
