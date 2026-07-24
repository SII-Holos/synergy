import { describe, expect, test } from "bun:test"
import { Box, Text } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

describe("OpenTUI framework contract", () => {
  test("captures CJK and emoji without corrupting terminal cells", async () => {
    const testRenderer = await createTestRenderer({ width: 24, height: 5 })
    testRenderer.renderer.root.add(Box({ flexDirection: "column" }, Text({ content: "Synergy 你好 👋🏽" })))

    await testRenderer.renderOnce()
    const frame = testRenderer.captureCharFrame()

    expect(frame).toContain("Synergy 你好 👋🏽")
    testRenderer.renderer.destroy()
  })

  test("reflows content after terminal resize", async () => {
    const testRenderer = await createTestRenderer({ width: 20, height: 6 })
    testRenderer.renderer.root.add(Text({ content: "one two three four five", wrapMode: "word" }))

    await testRenderer.renderOnce()
    const wide = testRenderer.captureCharFrame()
    testRenderer.resize(10, 6)
    await testRenderer.renderOnce()
    const narrow = testRenderer.captureCharFrame()

    expect(narrow).not.toBe(wide)
    expect(narrow.split("\n").filter((line) => line.trim()).length).toBeGreaterThan(1)
    testRenderer.renderer.destroy()
  })
})
