import { expect, test } from "bun:test"
import { MAX_TOOL_ICON_BYTES, toolIconSources } from "../src/tool-display"

const src = "data:image/png;base64,iVBORw0KGgo="

test("display images retain supported theme data without following remote references", () => {
  expect(toolIconSources([{ src, theme: "dark", mimeType: "image/png", extra: "ignored" }])).toEqual([
    { src, theme: "dark", mimeType: "image/png" },
  ])
  for (const value of [
    null,
    "image",
    {},
    [null],
    [{ src: "https://example.test/icon.png" }],
    [{ src, theme: "other" }],
    [{ src: "data:text/html;base64,aGVsbG8=" }],
  ])
    expect(toolIconSources(value)).toEqual([])
})

test("display image count and encoded data are bounded", () => {
  expect(toolIconSources(Array.from({ length: 10 }, () => ({ src })))).toHaveLength(3)
  expect(toolIconSources([{ src: `data:image/png;base64,${"A".repeat(MAX_TOOL_ICON_BYTES * 2)}` }])).toEqual([])
})
