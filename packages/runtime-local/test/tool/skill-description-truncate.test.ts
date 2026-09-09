import { describe, expect, test } from "bun:test"
import { truncateSkillDescription } from "@ericsanchezok/synergy-runtime-local/tools/skill"

describe("truncateSkillDescription", () => {
  test("empty input returns an empty string", () => {
    expect(truncateSkillDescription("")).toBe("")
  })

  test("whitespace-only input returns an empty string", () => {
    expect(truncateSkillDescription("   \n\t\t  ")).toBe("")
  })

  test("keeps a short description unchanged apart from collapsing internal whitespace", () => {
    expect(truncateSkillDescription("  Route   changes to the   focused owner.  ")).toBe(
      "Route changes to the focused owner.",
    )
  })

  test("a description of exactly 100 characters passes through without an ellipsis", () => {
    const description = "a".repeat(100)
    expect(truncateSkillDescription(description)).toBe(description)
  })

  test("keeps only the first line of a multi-line description", () => {
    const firstLine = "Route the change to the owning skill."
    const description = `${firstLine}\nSecond line with many hundreds of characters that must never appear in the result.`
    const result = truncateSkillDescription(description)
    expect(result).toBe(firstLine)
    expect(result).not.toContain("\n")
  })

  test("truncates a long description to one line, at most 104 chars, ending with an ellipsis at a word boundary", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`)
    const description = words.join(" ")
    const result = truncateSkillDescription(description)
    expect(result.length).toBeLessThanOrEqual(104)
    expect(result).not.toContain("\n")
    expect(result.endsWith("…")).toBe(true)
    const content = result.slice(0, -1)
    expect(content.length).toBeLessThanOrEqual(100)
    expect(description.startsWith(content)).toBe(true)
    expect(description[content.length]).toBe(" ")
  })

  test("hard-cuts a single unbroken word longer than 100 characters at the cap", () => {
    const description = "x".repeat(300)
    expect(truncateSkillDescription(description)).toBe(`${"x".repeat(100)}…`)
  })
})
