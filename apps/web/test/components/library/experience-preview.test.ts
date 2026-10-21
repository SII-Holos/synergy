import { expect, test } from "bun:test"
import { experiencePreview } from "../../../src/components/library/experience-preview"

test("an experience preview uses its first non-empty paragraph without duplicating the full answer", () => {
  expect(
    experiencePreview(" \n\n  A readable heading\nwith its second line\n\nSupporting content.\n\nFurther detail."),
  ).toEqual({ title: "A readable heading\nwith its second line", summary: "Supporting content.\n\nFurther detail." })
  expect(experiencePreview("One paragraph only")).toEqual({ title: "One paragraph only", summary: "" })
  expect(experiencePreview(" \n\n ")).toEqual({ title: "", summary: "" })
})

test("a single-line intent uses its stored trajectory as the preview without rewriting either", () => {
  expect(experiencePreview("Inspect pending experiences", "1. Read records.\n2. Check source references.")).toEqual({
    title: "Inspect pending experiences",
    summary: "1. Read records. 2. Check source references.",
  })
  expect(experiencePreview("Intent\n\nLegacy context", "  ")).toEqual({ title: "Intent", summary: "Legacy context" })
})
