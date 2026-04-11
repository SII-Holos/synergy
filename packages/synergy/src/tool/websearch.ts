import z from "zod"
import { Tool } from "./tool"
import { Flag } from "../flag/flag"
import DESCRIPTION from "./websearch.txt"
import { HolosRequest } from "@/holos/request"

interface SearXNGResult {
  title: string
  url: string
  content: string
  engine: string
  engines?: string[]
  score?: number
  publishedDate?: string
}

interface SearXNGResponse {
  query: string
  number_of_results: number
  results: SearXNGResult[]
  suggestions: string[]
  infoboxes?: Array<{
    infobox: string
    content: string
    urls: Array<{ title: string; url: string }>
  }>
}

export const WebSearchTool = Tool.define("websearch", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Websearch query"),
    numResults: z.number().optional().describe("Number of search results to return (default: 10)"),
    language: z.string().optional().describe("Search language code (e.g., 'en', 'zh', 'de'). Default: 'auto'"),
    categories: z
      .enum(["general", "images", "videos", "news", "it", "science", "files", "social media"])
      .optional()
      .describe("Search category (default: 'general')"),
    timeRange: z.enum(["day", "month", "year"]).optional().describe("Filter results by time range"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "websearch",
      patterns: [params.query],
      metadata: {
        query: params.query,
        numResults: params.numResults,
        language: params.language,
        categories: params.categories,
        timeRange: params.timeRange,
      },
    })

    const searchParams = new URLSearchParams({
      q: params.query,
      format: "json",
    })

    if (params.language) searchParams.set("language", params.language)
    if (params.categories) searchParams.set("categories", params.categories)
    if (params.timeRange) searchParams.set("time_range", params.timeRange)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 25000)

    const url = `${Flag.SYNERGY_SEARXNG_URL}/search?${searchParams}`

    const response = await HolosRequest.fetch(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
        },
        signal: AbortSignal.any([controller.signal, ctx.abort]),
      },
      { capability: "websearch" },
    ).catch((error) => {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Search request timed out")
      }
      throw error
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Search error (${response.status}): ${errorText}`)
    }

    const data: SearXNGResponse = await response.json()

    const numResults = params.numResults ?? 10
    const results = data.results.slice(0, numResults)

    if (results.length === 0) {
      return {
        output: "No search results found. Please try a different query.",
        title: `Web search: ${params.query}`,
        metadata: {
          totalResults: 0,
          returnedResults: 0,
        },
      }
    }

    const formattedResults = results
      .map((r, i) => {
        const parts = [`${i + 1}. **${r.title}**`, `   URL: ${r.url}`]
        if (r.content) parts.push(`   ${r.content}`)
        if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`)
        return parts.join("\n")
      })
      .join("\n\n")

    let output = `Found ${data.results.length} results for "${params.query}":\n\n${formattedResults}`

    if (data.suggestions && data.suggestions.length > 0) {
      output += `\n\n**Related searches:** ${data.suggestions.slice(0, 5).join(", ")}`
    }

    if (data.infoboxes && data.infoboxes.length > 0) {
      const infobox = data.infoboxes[0]
      output = `**${infobox.infobox}**\n${infobox.content}\n\n---\n\n${output}`
    }

    return {
      output,
      title: `Web search: ${params.query}`,
      metadata: {
        totalResults: data.results.length,
        returnedResults: results.length,
      },
    }
  },
})
