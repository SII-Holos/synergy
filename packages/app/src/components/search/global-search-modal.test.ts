import { describe, expect, test } from "bun:test"
import { resolveArchivedInput } from "./global-search-utils"

describe("resolveArchivedInput", () => {
  test("returns includeArchived=false for plain queries", () => {
    const result = resolveArchivedInput("hello")
    expect(result.search).toBe("hello")
    expect(result.includeArchived).toBe(false)
  })

  test("returns includeArchived=false for empty string", () => {
    const result = resolveArchivedInput("")
    expect(result.search).toBe("")
    expect(result.includeArchived).toBe(false)
  })

  test("detects archived: prefix case-insensitively", () => {
    const result = resolveArchivedInput("archived: my query")
    expect(result.search).toBe("my query")
    expect(result.includeArchived).toBe(true)
  })

  test("detects ARCHIVED: prefix (uppercase)", () => {
    const result = resolveArchivedInput("ARCHIVED: my query")
    expect(result.search).toBe("my query")
    expect(result.includeArchived).toBe(true)
  })

  test("detects Archived: prefix (mixed case)", () => {
    const result = resolveArchivedInput("Archived: my query")
    expect(result.search).toBe("my query")
    expect(result.includeArchived).toBe(true)
  })

  test("handles leading whitespace before prefix", () => {
    const result = resolveArchivedInput("   archived: my query")
    expect(result.search).toBe("my query")
    expect(result.includeArchived).toBe(true)
  })

  test("strips whitespace between prefix and search term", () => {
    const result = resolveArchivedInput("archived:    my query")
    expect(result.search).toBe("my query")
    expect(result.includeArchived).toBe(true)
  })

  test("returns empty search when only prefix is given", () => {
    const result = resolveArchivedInput("archived:")
    expect(result.search).toBe("")
    expect(result.includeArchived).toBe(true)
  })

  test("returns empty search when prefix with trailing whitespace only", () => {
    const result = resolveArchivedInput("archived:   ")
    expect(result.search).toBe("")
    expect(result.includeArchived).toBe(true)
  })

  test("does NOT match prefix in the middle of the query", () => {
    const result = resolveArchivedInput("search archived: stuff")
    expect(result.search).toBe("search archived: stuff")
    expect(result.includeArchived).toBe(false)
  })

  test("does NOT match archived without colon", () => {
    const result = resolveArchivedInput("archived sessions")
    expect(result.search).toBe("archived sessions")
    expect(result.includeArchived).toBe(false)
  })

  test("does NOT match archive: (different word)", () => {
    const result = resolveArchivedInput("archive: old stuff")
    expect(result.search).toBe("archive: old stuff")
    expect(result.includeArchived).toBe(false)
  })

  test("preserves trailing whitespace in plain queries", () => {
    const result = resolveArchivedInput("hello   ")
    expect(result.search).toBe("hello   ")
    expect(result.includeArchived).toBe(false)
  })
})
