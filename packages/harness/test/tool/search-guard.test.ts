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

  test("detects exact duplicate fetches from recorded attempts", () => {
    const input = { url: "https://example.com/docs", format: "markdown" }
    const records = [{ tool: "webfetch", signature: SearchGuard.signature("webfetch", input) }]
    const duplicate = SearchGuard.checkDuplicate(records, "webfetch", input)
    expect(duplicate?.output).toContain("Search skipped")
  })

  test("does not treat changed format as the same fetch", () => {
    const records = [
      {
        tool: "webfetch",
        signature: SearchGuard.signature("webfetch", {
          url: "https://example.com/docs",
          format: "markdown",
        }),
      },
    ]

    const duplicate = SearchGuard.checkDuplicate(records, "webfetch", {
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
