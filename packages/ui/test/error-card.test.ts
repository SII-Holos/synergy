import { describe, expect, test } from "bun:test"
import { errorDetailsText, errorPreview } from "../src/components/error-card-content"

describe("ErrorCard", () => {
  test("uses only the first error line in the message flow", () => {
    const preview = errorPreview("oldString not found in content\n\nThe most similar lines are:\nprivate-token")

    expect(preview).toBe("oldString not found in content")
  })

  test("preserves the complete error and tool input for the details dialog", () => {
    expect(errorDetailsText("oldString not found", { oldString: "private-token" })).toBe(
      'oldString not found\n\nInput:\n{\n  "oldString": "private-token"\n}',
    )
  })
})
