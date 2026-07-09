import { describe, expect, test } from "bun:test"
import { computeReviewOpenForSelectedFile } from "./review-open-model"

describe("computeReviewOpenForSelectedFile", () => {
  test("appends selectedFile to open list when not already present", () => {
    const result = computeReviewOpenForSelectedFile("src/app.ts", ["src/app.ts", "src/util.ts"], ["src/util.ts"])
    expect(result).toEqual(["src/util.ts", "src/app.ts"])
  })

  test("returns undefined when selectedFile is undefined", () => {
    const result = computeReviewOpenForSelectedFile(undefined, ["src/app.ts", "src/util.ts"], [])
    expect(result).toBeUndefined()
  })

  test("returns undefined when selectedFile is not in diffs list", () => {
    const result = computeReviewOpenForSelectedFile("src/missing.ts", ["src/app.ts", "src/util.ts"], [])
    expect(result).toBeUndefined()
  })

  test("returns undefined when selectedFile is already in open list", () => {
    const result = computeReviewOpenForSelectedFile(
      "src/app.ts",
      ["src/app.ts", "src/util.ts"],
      ["src/util.ts", "src/app.ts"],
    )
    expect(result).toBeUndefined()
  })

  test("returns single-element array when open list is empty and selectedFile is in diffs", () => {
    const result = computeReviewOpenForSelectedFile("src/app.ts", ["src/app.ts"], [])
    expect(result).toEqual(["src/app.ts"])
  })

  test("returns undefined when selectedFile is an empty string", () => {
    const result = computeReviewOpenForSelectedFile("", ["src/app.ts"], [])
    expect(result).toBeUndefined()
  })

  test("preserves other open items and ordering when appending", () => {
    const result = computeReviewOpenForSelectedFile(
      "src/new.ts",
      ["src/a.ts", "src/new.ts", "src/b.ts"],
      ["src/a.ts", "src/b.ts"],
    )
    expect(result).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"])
  })
})
