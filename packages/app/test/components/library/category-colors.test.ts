import { expect, test } from "bun:test"
import { MEMORY_CATEGORIES, categoryColors } from "../../../src/components/library/category-colors"

test("memory categories keep distinct themed badge colors", () => {
  const productCategories = MEMORY_CATEGORIES.filter((category) => category !== "general")
  const styles = productCategories.map((category) => categoryColors[category])

  expect(new Set(styles).size).toBe(productCategories.length)
  for (const style of styles) {
    expect(style).not.toContain("[")
    expect(style).toContain("text-text-strong")
  }
})
