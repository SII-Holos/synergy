import { describe, expect, test } from "bun:test"

describe("RawMessageCodePreview loading boundary", () => {
  test("loads without eagerly importing the shared Code renderer worker", async () => {
    const module = await import("./raw-message-code-preview")
    expect(typeof module.RawMessageCodePreview).toBe("function")
  })
})
