import { describe, expect, test } from "bun:test"
import {
  ANYSEARCH_TOOL_NAMES,
  batchSearchView,
  getAnysearchToolInfo,
  isAnysearchToolName,
  parseToolBatchCounts,
  parseToolResultRows,
  toolElapsedLabel,
  toolResultRowMeta,
} from "../../../src/components/tool/anysearch-info"
import {
  getScholightToolInfo,
  isScholightToolName,
  SCHOLIGHT_TOOL_NAMES,
} from "../../../src/components/tool/scholight-info"

describe("remote MCP search tool name catalogs", () => {
  test("anysearch covers the four canonical ids", () => {
    expect(ANYSEARCH_TOOL_NAMES).toEqual([
      "mcp__anysearch__search",
      "mcp__anysearch__batch_search",
      "mcp__anysearch__extract",
      "mcp__anysearch__get_sub_domains",
    ])
  })

  test("scholight covers the two canonical ids", () => {
    expect(SCHOLIGHT_TOOL_NAMES).toEqual(["mcp__scholight__search_papers", "mcp__scholight__extract_url"])
  })

  test("guards recognize every canonical id", () => {
    for (const id of ANYSEARCH_TOOL_NAMES) expect(isAnysearchToolName(id)).toBe(true)
    for (const id of SCHOLIGHT_TOOL_NAMES) expect(isScholightToolName(id)).toBe(true)
    expect(isAnysearchToolName("mcp__scholight__search_papers")).toBe(false)
    expect(isScholightToolName("mcp__anysearch__search")).toBe(false)
    expect(isAnysearchToolName("webfetch")).toBe(false)
  })
})

describe("search output parsers", () => {
  test("parseToolResultRows reads a bare JSON paper array", () => {
    const output = JSON.stringify([
      { title: "Attention Is All You Need", year: "2017", venue: "NeurIPS", score: 0.98 },
      { title: "BERT", year: "2018", venue: "NAACL", score: 0.95 },
    ])
    expect(parseToolResultRows(output)).toEqual([
      { title: "Attention Is All You Need", meta: "2017 · NeurIPS · score 0.98", url: undefined },
      { title: "BERT", meta: "2018 · NAACL · score 0.95", url: undefined },
    ])
  })

  test("parseToolResultRows reads nested result arrays and fenced JSON", () => {
    const output = [
      "```json",
      JSON.stringify({
        results: [{ title: "GPT-4", date: "2023-03-14", journal: "arXiv", url: "https://arxiv.org/abs/2303.08774" }],
      }),
      "```",
    ].join("\n")
    expect(parseToolResultRows(output)).toEqual([
      {
        title: "GPT-4",
        meta: "2023 · arXiv",
        url: "https://arxiv.org/abs/2303.08774",
      },
    ])
  })

  test("parseToolResultRows treats plain text and empty lists as unparseable", () => {
    expect(parseToolResultRows("found 3 papers for your query")).toBeUndefined()
    expect(parseToolResultRows("")).toBeUndefined()
    expect(parseToolResultRows(undefined)).toBeUndefined()
    expect(parseToolResultRows("[]")).toBeUndefined()
    expect(parseToolResultRows(JSON.stringify([1, 2]))).toBeUndefined()
  })

  test("parseToolResultRows falls back to name/heading titles", () => {
    expect(parseToolResultRows(JSON.stringify([{ name: "Swin", year: 2021 }]))).toEqual([
      { title: "Swin", meta: "2021", url: undefined },
    ])
  })

  test("toolResultRowMeta composes year, venue and score defensively", () => {
    expect(toolResultRowMeta({ year: "2020", venue: "ICML", score: 0.5 })).toBe("2020 · ICML · score 0.5")
    expect(toolResultRowMeta({ published_at: "2022-06-01T00:00:00Z", container_title: "Nature" })).toBe("2022 · Nature")
    expect(toolResultRowMeta({ score: 0.75 })).toBe("score 0.75")
    expect(toolResultRowMeta({})).toBeUndefined()
  })

  test("parseToolBatchCounts reads numeric arrays and count records", () => {
    expect(parseToolBatchCounts(JSON.stringify([12, 5, 0]))).toEqual([12, 5, 0])
    expect(parseToolBatchCounts(JSON.stringify([{ count: 4 }, { results: [{}, {}] }, {}]))).toEqual([4, 2, undefined])
    expect(parseToolBatchCounts(JSON.stringify({ counts: { "query one": 8, "query two": 3 } }))).toEqual([8, 3])
    expect(parseToolBatchCounts("batch completed: 8 results")).toBeUndefined()
    expect(parseToolBatchCounts(undefined)).toBeUndefined()
  })
})

describe("batchSearchView (C-card state machine)", () => {
  const queries = { queries: ["retrieval", { query: "self-attention" }] }

  test("pending lists the queries with no counts", () => {
    const view = batchSearchView(queries, undefined, null, "pending")
    expect(view.pending).toBe(true)
    expect(view.queries).toEqual(["retrieval", "self-attention"])
    expect(view.rows).toBeUndefined()
    expect(view.raw).toBeUndefined()
  })

  test("completed with countable output builds per-query rows, total and elapsed", () => {
    const view = batchSearchView(queries, JSON.stringify([10, 3]), { start: 1000, end: 3400 }, "completed")
    expect(view.pending).toBe(false)
    expect(view.rows).toEqual([
      { query: "retrieval", count: 10 },
      { query: "self-attention", count: 3 },
    ])
    expect(view.total).toBe(13)
    expect(view.elapsed).toBe("2.4s")
    expect(view.raw).toBeUndefined()
  })

  test("completed with unparseable output falls back to raw text", () => {
    const view = batchSearchView(queries, "batch finished\n8 results found", { start: 1, end: 2 }, "completed")
    expect(view.pending).toBe(false)
    expect(view.rows).toBeUndefined()
    expect(view.raw).toBe(true)
    expect(view.elapsed).toBe("1ms")
  })

  test("completed without counts for a query keeps the row countable", () => {
    const view = batchSearchView({ queries: ["a", "b"] }, JSON.stringify([7]), undefined, "completed")
    expect(view.rows).toEqual([
      { query: "a", count: 7 },
      { query: "b", count: undefined },
    ])
    expect(view.total).toBe(7)
  })

  test("running and generating stay pending; error with output uses completed path", () => {
    expect(batchSearchView(queries, undefined, null, "running").pending).toBe(true)
    expect(batchSearchView(queries, undefined, null, "generating").pending).toBe(true)
    expect(batchSearchView(queries, JSON.stringify([1]), { start: 1, end: 2 }, "error").raw).toBeUndefined()
  })
})

describe("toolElapsedLabel", () => {
  test("hidden when the part carries no usable time", () => {
    expect(toolElapsedLabel(undefined)).toBeUndefined()
    expect(toolElapsedLabel(null)).toBeUndefined()
    expect(toolElapsedLabel({ start: 1 })).toBeUndefined()
    expect(toolElapsedLabel({ end: 2 })).toBeUndefined()
  })

  test("formats millisecond, second and minute ranges", () => {
    expect(toolElapsedLabel({ start: 1000, end: 1840 })).toBe("840ms")
    expect(toolElapsedLabel({ start: 1000, end: 2400 })).toBe("1.4s")
    expect(toolElapsedLabel({ start: 1000, end: 12400 })).toBe("11s")
    expect(toolElapsedLabel({ start: 1000, end: 70000 })).toBe("1m 09s")
    expect(toolElapsedLabel({ start: 5000, end: 1000 })).toBe("0ms")
  })
})

describe("anysearch info builders", () => {
  test("search carries the query as subtitle and domains/results as tags", () => {
    const info = getAnysearchToolInfo("mcp__anysearch__search", {
      query: "vector database benchmarks",
      domains: ["github.com", "arxiv.org"],
      max_results: 5,
    })
    expect(info).toEqual({
      icon: "orbit",
      title: "Anysearch",
      subtitle: "vector database benchmarks",
      args: ["github.com", "arxiv.org", "5 results"],
    })
  })

  test("batch_search summarizes the query count", () => {
    expect(getAnysearchToolInfo("mcp__anysearch__batch_search", { queries: ["a", "b", "c"] })).toEqual({
      icon: "orbit",
      title: "Anysearch Batch",
      subtitle: "3 parallel searches",
      args: ["3 queries"],
    })
  })

  test("extract uses the hostname and format", () => {
    expect(
      getAnysearchToolInfo("mcp__anysearch__extract", { url: "https://arxiv.org/abs/2401.12345", format: "markdown" }),
    ).toEqual({
      icon: "orbit",
      title: "Anysearch Extract",
      subtitle: "https://arxiv.org/abs/2401.12345",
      args: ["arxiv.org", "markdown"],
    })
  })

  test("get_sub_domains lists the route labels", () => {
    expect(
      getAnysearchToolInfo("mcp__anysearch__get_sub_domains", { domain: "example.com", sub_domain: "research" }),
    ).toEqual({
      icon: "orbit",
      title: "Search Domains",
      subtitle: "example.com, research",
      args: ["2 domains", "vertical routing"],
    })
  })
})

describe("scholight info builders", () => {
  test("search_papers shows the query and structured search tags", () => {
    expect(
      getScholightToolInfo("mcp__scholight__search_papers", {
        query: "retrieval augmented generation",
        strength: "thorough",
        categories: ["cs.CL", "cs.AI"],
        authors: ["Karpathy"],
        limit: 20,
        start_date: "2026-03-01",
      }),
    ).toEqual({
      icon: "graduation-cap",
      title: "Scholight",
      subtitle: "retrieval augmented generation",
      args: ["thorough", "cs.CL, cs.AI", "Karpathy", "20 papers", "2026-03-01"],
    })
  })

  test("extract_url shows the host and output format", () => {
    expect(
      getScholightToolInfo("mcp__scholight__extract_url", {
        url: "https://arxiv.org/abs/2303.08774",
        format: "text",
      }),
    ).toEqual({
      icon: "file-text",
      title: "Scholight Extract",
      subtitle: "https://arxiv.org/abs/2303.08774",
      args: ["arxiv.org", "text"],
    })
  })
})
