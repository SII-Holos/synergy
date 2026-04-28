import { describe, expect, test } from "bun:test"
import { truncateMetadataOutput, MAX_METADATA_LENGTH } from "../../src/tool/bash/shared"

describe("truncateMetadataOutput", () => {
  test("returns short output unchanged", () => {
    const output = "hello world"
    expect(truncateMetadataOutput(output)).toBe(output)
  })

  test("returns empty string unchanged", () => {
    expect(truncateMetadataOutput("")).toBe("")
  })

  test("returns output at exactly MAX_METADATA_LENGTH unchanged", () => {
    const output = "x".repeat(MAX_METADATA_LENGTH)
    expect(truncateMetadataOutput(output)).toBe(output)
  })

  test("truncates output exceeding MAX_METADATA_LENGTH", () => {
    const output = "x".repeat(MAX_METADATA_LENGTH + 1000)
    const result = truncateMetadataOutput(output)
    expect(result.length).toBeLessThan(output.length)
    expect(result).toEndWith("\n\n...")
    // Should keep the first MAX_METADATA_LENGTH chars
    expect(result.startsWith("x".repeat(MAX_METADATA_LENGTH))).toBe(true)
  })

  test("truncation preserves the start of output (head strategy)", () => {
    const prefix = "IMPORTANT_START_"
    const output = prefix + "x".repeat(MAX_METADATA_LENGTH + 1000)
    const result = truncateMetadataOutput(output)
    expect(result.startsWith(prefix)).toBe(true)
  })
})
