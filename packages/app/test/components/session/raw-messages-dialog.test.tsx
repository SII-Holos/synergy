import { describe, expect, test } from "bun:test"

describe("RawMessageCodePreview loading boundary", () => {
  test("loads without eagerly importing the shared Code renderer worker", async () => {
    const module = await import("../../../src/components/session/raw-message-code-preview")
    expect(typeof module.RawMessageCodePreview).toBe("function")
  })

  test("switches the shared renderer between horizontal scrolling and soft wrapping", async () => {
    const { rawMessageCodeOverflow } = await import("../../../src/components/session/raw-message-code-preview")
    expect(rawMessageCodeOverflow(false)).toBe("scroll")
    expect(rawMessageCodeOverflow(true)).toBe("wrap")
  })
})
