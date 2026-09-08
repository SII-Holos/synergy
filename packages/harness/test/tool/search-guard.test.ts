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

  test("detects exact duplicate fetches per session", () => {
    SearchGuard.reset()

    const input = { url: "https://example.com/docs", format: "markdown" }
    SearchGuard.recordAttempt("ses_test", "webfetch", input)

    const duplicate = SearchGuard.checkDuplicate("ses_test", "webfetch", input)
    expect(duplicate?.output).toContain("Search skipped")
  })

  test("does not treat changed format as the same fetch", () => {
    SearchGuard.reset()

    SearchGuard.recordAttempt("ses_test", "webfetch", {
      url: "https://example.com/docs",
      format: "markdown",
    })

    const duplicate = SearchGuard.checkDuplicate("ses_test", "webfetch", {
      url: "https://example.com/docs",
      format: "text",
    })

    expect(duplicate).toBeUndefined()
  })

  test("detects very similar recent queries", () => {
    expect(
      SearchGuard.hasSimilarQueries([
        { tool: "webfetch", query: "large language model memory systems" },
        { tool: "webfetch", query: "memory systems large language model" },
      ]),
    ).toBe(true)
  })
})
