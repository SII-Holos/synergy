import { describe, expect, test } from "bun:test"
import { SearchGuard } from "../../src/tool/search-guard"

describe("SearchGuard", () => {
  test("classifies common search failures", () => {
    expect(SearchGuard.classifyHttpStatus(403)).toBe("http_403")
    expect(SearchGuard.classifyHttpStatus(404)).toBe("http_404")
    expect(SearchGuard.classifyHttpStatus(429)).toBe("blocked_or_unavailable")
    expect(SearchGuard.classifyError("Search request timed out")).toBe("timeout")
    expect(SearchGuard.classifyError("HolosCapabilityUnavailableError: Web search is unavailable")).toBe(
      "blocked_or_unavailable",
    )
  })

  test("detects exact duplicate searches per session", () => {
    SearchGuard.reset()

    const input = { query: "retrieval augmented generation", categories: "science" }
    SearchGuard.recordAttempt("ses_test", "websearch", input)

    const duplicate = SearchGuard.checkDuplicate("ses_test", "websearch", input)
    expect(duplicate?.output).toContain("Search skipped")
  })

  test("does not treat changed filters as the same search", () => {
    SearchGuard.reset()

    SearchGuard.recordAttempt("ses_test", "arxiv_search", {
      query: "agent memory",
      startDate: "2026-01-01",
    })

    const duplicate = SearchGuard.checkDuplicate("ses_test", "arxiv_search", {
      query: "agent memory",
      startDate: "2025-01-01",
    })

    expect(duplicate).toBeUndefined()
  })

  test("detects very similar recent queries", () => {
    expect(
      SearchGuard.hasSimilarQueries([
        { tool: "websearch", query: "large language model memory systems" },
        { tool: "websearch", query: "memory systems large language model" },
      ]),
    ).toBe(true)
  })
})
