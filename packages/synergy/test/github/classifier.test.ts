import { describe, expect, test } from "bun:test"
import { parseGitHubClassification } from "../../src/github/classifier"

describe("GitHub nano classifier output", () => {
  test("validates a bounded JSON decision", () => {
    expect(
      parseGitHubClassification('{"relevant":true,"category":"bug","confidence":0.92,"reason":"Reproducible crash"}'),
    ).toEqual({
      relevant: true,
      category: "bug",
      confidence: 0.92,
      reason: "Reproducible crash",
    })
  })

  test("fails soft on malformed, out-of-range, or unrelated output", () => {
    expect(parseGitHubClassification("not json")).toBeUndefined()
    expect(parseGitHubClassification('{"relevant":true,"category":"bug","confidence":2,"reason":"x"}')).toBeUndefined()
    expect(
      parseGitHubClassification('{"relevant":true,"category":"other","confidence":0.9,"reason":"x"}'),
    ).toBeUndefined()
  })
})
