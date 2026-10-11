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

  test("retains fetched-content quality information", () => {
    const quality = SearchGuard.assessWebContent("Loading...", "text/html")
    expect(quality?.failureType).toBe("low_quality_results")
    expect(SearchGuard.appendQualityWarning("Loading...", quality!.reason)).toContain("Loading...")
    expect(SearchGuard.assessWebContent("complete content", "text/plain")).toBeUndefined()
  })
})
