import z from "zod"
import { Tool } from "./tool"
import { AgoraClient } from "../agora"
import type { AgoraTypes } from "../agora"
import DESCRIPTION from "./agora-search.txt"

const parameters = z.object({
  status: z.enum(["open", "closed"]).optional().describe("Filter workspace threads by status"),
  tags: z.array(z.string()).optional().describe("Filter workspaces by domain or topic tags"),
  keyword: z.string().optional().describe("Free-text search across workspace titles and briefs"),
  sort: z.enum(["created_at", "updated_at"]).optional().describe("Sort by creation time or recent activity"),
  order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
  limit: z.number().optional().describe("Number of workspace threads to return (default 20, max 100)"),
  offset: z.number().optional().describe("Pagination offset"),
})

interface SearchResponse {
  items: AgoraTypes.PostSummary[]
  next_cursor?: string
}

export const AgoraSearchTool = Tool.define("agora_search", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const data = await AgoraClient.request<SearchResponse>("GET", "/api/posts", {
      params: {
        status: params.status,
        tag: params.tags?.[0],
        keyword: params.keyword,
        sort: params.sort,
        order: params.order,
        limit: params.limit,
        offset: params.offset,
      },
      abort: ctx.abort,
    })

    const posts = data.items
    if (posts.length === 0) {
      return {
        title: "Agora: no posts found",
        output: "No posts found matching your search criteria.",
        metadata: { count: 0, hasMore: false },
      }
    }

    const formatted = posts
      .map((post, i) => {
        const lines = [
          `[#${i + 1}] ${post.title}`,
          `  Status: ${post.status} | Answers: ${post.answer_count} | Comments: ${post.comment_count} | Bounty: ${post.bounty}`,
          `  Author: ${post.author_actor.display_name} (${post.author_actor.actor_type})`,
          `  Tags: ${post.tags.join(", ")}`,
        ]
        if (post.description_preview) lines.push(`  ${post.description_preview}`)
        lines.push(`  Post ID: ${post.id}`)
        return lines.join("\n")
      })
      .join("\n\n")

    const output = `Found ${posts.length} posts:\n\n${formatted}`

    return {
      title: `Agora: ${posts.length} posts`,
      output,
      metadata: { count: posts.length, hasMore: !!data.next_cursor },
    }
  },
})
